/* ---------------------------------------------------------------------------
   triangulate.ts — the signals & triangulation engine (Epic G).

   The highest-order cross-project value is LATENT: a theme that's weak in any one
   engagement but strong across many. No single project sees it; it only emerges
   from triangulation across the firm's work. This is not a query — it's a batch
   aggregation that has to be COMPUTED and surfaced.

   Method: cluster the transferable findings distilled onto every project card
   (G1). A cluster that spans several engagements — ideally several CLIENTS and
   SECTORS — is an emergent firm insight (G2). Each is synthesised into a crisp
   statement, scored by breadth of support, and ROUTED to whoever should act on it
   (leadership / marketing / sales / practice) (G3). Emergent insights are proposed,
   not asserted — they flow into the same nomination → review pipeline as any other
   shared-memory candidate.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { listCards, type ProjectCard } from "./cards";
import { embed } from "./embed";
import { cosine } from "./vectors";

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5";

const SIM_THRESHOLD = 0.44; // findings this similar are the "same theme"
const MIN_PROJECTS = 3; // a theme must span at least this many engagements to be "emergent"

type Finding = { text: string; project: string; client: string; sector: string; title: string };

export type EmergentTheme = {
  insight: string;
  route: string; // leadership | marketing | sales | practice
  action: string;
  support: { projects: string[]; clients: string[]; sectors: string[]; count: number };
  evidence: string[]; // the raw findings that clustered
};

// Greedy single-link clustering over the finding embeddings. Small N (dozens of
// findings), so this is simple + fast; upgrade to proper clustering if the corpus
// grows into the thousands.
function cluster(findings: Finding[], vecs: number[][]): number[][] {
  const clusters: number[][] = [];
  for (let i = 0; i < findings.length; i++) {
    let placed = false;
    for (const c of clusters) {
      if (c.some((j) => cosine(vecs[i], vecs[j]) >= SIM_THRESHOLD)) {
        c.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }
  return clusters;
}

export async function detectEmergentThemes(): Promise<EmergentTheme[]> {
  const cards = listCards();
  const findings: Finding[] = [];
  for (const c of cards) {
    for (const f of c.keyFindings) {
      if (f && f.trim()) findings.push({ text: f, project: c.project, client: c.client, sector: c.sector, title: c.title });
    }
  }
  if (findings.length < MIN_PROJECTS) return [];

  const vecs = await embed(findings.map((f) => f.text));
  const clusters = cluster(findings, vecs);

  // Keep clusters that span enough DISTINCT engagements — that's what makes a theme
  // emergent rather than one project's opinion repeated.
  const strong = clusters
    .map((idxs) => idxs.map((i) => findings[i]))
    .filter((members) => new Set(members.map((m) => m.project)).size >= MIN_PROJECTS)
    .sort((a, b) => new Set(b.map((m) => m.project)).size - new Set(a.map((m) => m.project)).size);

  const themes = await Promise.all(strong.map(synthesiseTheme));
  return themes.filter((t): t is EmergentTheme => !!t);
}

async function synthesiseTheme(members: Finding[]): Promise<EmergentTheme | null> {
  const projects = [...new Set(members.map((m) => m.project))];
  const clients = [...new Set(members.map((m) => m.client))];
  const sectors = [...new Set(members.map((m) => m.sector))];
  const evidence = members.map((m) => `- (${m.sector}) ${m.text}`);

  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 300,
    system:
      "These findings recur across several of the firm's engagements. Name the EMERGENT theme they share — the pattern " +
      "no single engagement fully saw — and say what the firm should do about it. Return STRICT JSON: " +
      `{"insight":string,"route":string,"action":string}. insight = one sharp sentence stating the pattern (no client names). ` +
      "route ∈ {leadership, marketing, sales, practice}. action = the concrete move (a POV to publish, an offering to " +
      "package, a BD play, a delivery standard). JSON only, no preamble.",
    messages: [{ role: "user", content: `Findings spanning ${projects.length} engagements across ${sectors.length} sector(s):\n${evidence.join("\n")}\n\nJSON:` }],
  });
  const text = response.content.find((b) => b.type === "text");
  let parsed: { insight?: string; route?: string; action?: string } = {};
  try {
    const raw = text && text.type === "text" ? text.text : "";
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (!parsed.insight) return null;
  return {
    insight: String(parsed.insight),
    route: String(parsed.route ?? "practice"),
    action: String(parsed.action ?? ""),
    support: { projects, clients, sectors, count: projects.length },
    evidence,
  };
}
