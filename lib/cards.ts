/* ---------------------------------------------------------------------------
   cards.ts — project summary cards (tickets B1–B3).

   A "card" is a compact, generated digest of one engagement: what it was, its key
   findings, and its outcome. Cards are the COARSE layer of cross-project retrieval:
   a firm- or sector-wide question is answered by first finding the relevant
   PROJECTS (via their cards) and then drilling into those projects' chunks. That
   two-stage "find projects → drill in" is far more precise at scale than a flat
   search over thousands of chunks, and it mirrors the scope lattice.

   Cards also help cold start: a card can be generated retroactively for any
   backfilled historical engagement, so past work becomes first-class substrate.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { getDb, encodeVec } from "./db";
import { embedOne } from "./embed";
import { listFiles, readFile } from "./corpus";
import { getProjectConfig } from "./project";

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5"; // card generation is summarisation — Haiku is plenty

export type ProjectCard = {
  project: string;
  client: string;
  sector: string;
  type: string;
  status: string;
  title: string;
  summary: string;
  keyFindings: string[];
  outcome: string;
  updated: string;
};

type CardRow = {
  project: string; client: string; sector: string; type: string; status: string;
  title: string; summary: string; key_findings: string; outcome: string; updated: string;
};

function rowToCard(r: CardRow): ProjectCard {
  let keyFindings: string[] = [];
  try {
    keyFindings = JSON.parse(r.key_findings ?? "[]");
  } catch {
    keyFindings = [];
  }
  return { ...r, keyFindings };
}

// A card's searchable text — what a cross-project query matches against.
function cardText(c: Pick<ProjectCard, "title" | "summary" | "keyFindings" | "outcome" | "sector" | "client">): string {
  return [c.title, `${c.sector} · ${c.client}`, c.summary, c.keyFindings.join(" "), c.outcome].filter(Boolean).join("\n");
}

// Read a project's corpus (bounded) as the source material for the card.
async function projectCorpusDigest(projectId: string): Promise<string> {
  const files = await listFiles(projectId).catch(() => [] as string[]);
  const parts: string[] = [];
  let budget = 12000; // chars — keep the generation cheap
  for (const f of files) {
    if (f === "engagement.md") continue; // constraints, not content
    const body = await readFile(projectId, f).catch(() => "");
    if (!body) continue;
    const slice = body.slice(0, 2500);
    parts.push(`### ${f}\n${slice}`);
    budget -= slice.length;
    if (budget <= 0) break;
  }
  return parts.join("\n\n");
}

// Generate (and persist) a card for one project from its corpus + config.
export async function generateCard(projectId: string): Promise<ProjectCard> {
  const cfg = await getProjectConfig(projectId);
  const corpus = await projectCorpusDigest(projectId);

  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 500,
    system:
      "You write a concise KNOWLEDGE CARD summarising a consulting engagement so it can be found and reused on future " +
      "work. Ground every field ONLY in the material provided — never invent. Return STRICT JSON: " +
      `{"title":string,"summary":string,"keyFindings":string[],"outcome":string}. ` +
      "title = ≤8 words. summary = 1–2 sentences on what the engagement was and the core insight. keyFindings = 2–4 " +
      "short, transferable lessons (not client-identifying trivia). outcome = one line on the recommendation/result, or " +
      `"in progress" if unclear. JSON only, no preamble.`,
    messages: [
      {
        role: "user",
        content: `Engagement: ${cfg.name} — client "${cfg.client}", sector ${cfg.sector}, type ${cfg.type}, status ${cfg.status}.\n\nCorpus:\n${corpus || "(no files)"}\n\nJSON:`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.type === "text"
    ? (response.content.find((b) => b.type === "text") as { text: string }).text
    : "";
  let parsed: { title?: string; summary?: string; keyFindings?: unknown; outcome?: string } = {};
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = {};
  }

  const card: ProjectCard = {
    project: projectId,
    client: cfg.client,
    sector: cfg.sector,
    type: cfg.type,
    status: cfg.status,
    title: String(parsed.title ?? cfg.name),
    summary: String(parsed.summary ?? ""),
    keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.map(String).slice(0, 4) : [],
    outcome: String(parsed.outcome ?? (cfg.status === "complete" ? "complete" : "in progress")),
    updated: new Date().toISOString(),
  };

  await saveCard(card);
  return card;
}

// Persist a card + its embedding (for coarse retrieval).
export async function saveCard(card: ProjectCard): Promise<void> {
  const db = getDb();
  const vec = await embedOne(cardText(card));
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO project_cards (project,client,sector,type,status,title,summary,key_findings,outcome,updated)
       VALUES (@project,@client,@sector,@type,@status,@title,@summary,@key_findings,@outcome,@updated)`
    ).run({ ...card, key_findings: JSON.stringify(card.keyFindings) });
    db.prepare("INSERT OR REPLACE INTO cards_vec (project, sector, embedding) VALUES (?, ?, ?)").run(card.project, card.sector, encodeVec(vec));
  })();
}

export function getCard(projectId: string): ProjectCard | null {
  const r = getDb().prepare("SELECT * FROM project_cards WHERE project = ?").get(projectId) as CardRow | undefined;
  return r ? rowToCard(r) : null;
}

export function listCards(): ProjectCard[] {
  const rows = getDb().prepare("SELECT * FROM project_cards ORDER BY sector, client").all() as CardRow[];
  return rows.map(rowToCard);
}

// Asset density per sector (ticket D5): how "warm" each sector is. Firm-level
// lenses (sales, marketing, signals) only become useful once a sector crosses a
// threshold of knowledge, so this tells us where the asset is ready — and where to
// point cold-start seeding. Deliberately dependency-light so scripts + the UI can
// both call it.
export type SectorDensity = { sector: string; projects: number; clients: number; cards: number; lessons: number; ready: boolean };

export async function sectorDensity(): Promise<SectorDensity[]> {
  const { listAllMemories } = await import("./memory");
  const cards = listCards();
  const memories = await listAllMemories();
  const bySector = new Map<string, SectorDensity>();
  const get = (sector: string) =>
    bySector.get(sector) ?? bySector.set(sector, { sector, projects: 0, clients: 0, cards: 0, lessons: 0, ready: false }).get(sector)!;

  const clientsBySector = new Map<string, Set<string>>();
  for (const c of cards) {
    const d = get(c.sector);
    d.cards += 1;
    d.projects += 1;
    (clientsBySector.get(c.sector) ?? clientsBySector.set(c.sector, new Set()).get(c.sector)!).add(c.client);
  }
  // Learned lessons that sit at or above the sector level count toward density.
  for (const m of memories) {
    if (m.type !== "learned" || (m.status ?? "active") === "retracted") continue;
    const sectorMatch = m.scope.match(/^sector\/([^/]+)/);
    if (sectorMatch) get(sectorMatch[1]).lessons += 1;
  }
  for (const [sector, set] of clientsBySector) get(sector).clients = set.size;
  // "Ready" heuristic: enough distinct clients + cards that a cross-client answer is
  // credible and not just one engagement's opinion.
  for (const d of bySector.values()) d.ready = d.clients >= 2 && d.cards >= 2;
  return [...bySector.values()].sort((a, b) => b.cards - a.cards);
}

// Coarse retrieval: the projects whose cards are most relevant to a query, within
// an optional scope (a set of project ids and/or sectors). Returns project ids +
// relevance, most relevant first — the entry point to hierarchical retrieval.
export async function searchCards(
  query: string,
  scope: { projectIds?: string[]; sectors?: string[] } | undefined,
  k = 8
): Promise<{ project: string; score: number; card: ProjectCard }[]> {
  const db = getDb();
  const q = encodeVec(await embedOne(query));
  // KNN over all cards, then filter to scope in JS (card counts are small — dozens
  // to low thousands — so a generous k + filter is simpler and robust than a vec0
  // metadata IN-filter).
  const rows = db
    .prepare("SELECT project, distance FROM cards_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
    .all(q, Math.max(k * 3, 24)) as { project: string; distance: number }[];
  const out: { project: string; score: number; card: ProjectCard }[] = [];
  for (const r of rows) {
    const card = getCard(r.project);
    if (!card) continue;
    if (scope?.projectIds && !scope.projectIds.includes(r.project)) continue;
    if (scope?.sectors && !scope.sectors.includes(card.sector)) continue;
    out.push({ project: r.project, score: 1 - r.distance, card });
    if (out.length >= k) break;
  }
  return out;
}
