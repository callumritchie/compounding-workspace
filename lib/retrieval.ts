/* ---------------------------------------------------------------------------
   retrieval.ts — cross-project retrieval + synthesis (tickets A4, A5).

   Answering "across projects" naively (flat-search everything, stuff into context)
   breaks at scale: relevance dilutes, one verbose project dominates, and the window
   overflows. This module does it properly:

     1. COARSE  (find projects) — searchCards() ranks the space's projects by their
        summary cards, so we work from the few relevant engagements, not thousands
        of chunks. Mirrors the scope lattice.
     2. FINE    (drill in)      — searchProjects() pulls the best passages from those
        projects, with a per-project cap for BREADTH across engagements.
     3. MAP     (extract)       — Haiku extracts each project's relevant evidence in
        parallel (cheap, bounded).
     4. REDUCE  (synthesise)    — Opus writes the cross-project answer from the
        extracts, carrying PROVENANCE so every claim traces to engagements.

   The map-reduce shape is what keeps a firm-wide question inside the context window
   while still drawing on many engagements.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { searchCards, getCard, type ProjectCard } from "./cards";
import { searchProjects, type CrossResult } from "./vectors";

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5"; // per-project extraction (map)
const MODEL = "claude-opus-4-8"; // cross-project synthesis (reduce)

export type ProjectEvidence = { project: string; card: ProjectCard | null; evidence: string; passages: CrossResult[] };
export type CrossAnswer = { answer: string; projectsUsed: { project: string; title: string; client: string; sector: string }[] };

// COARSE → FINE. Returns the top projects for a query within a scope, each with the
// best passages drilled from it. `scope` filters cards (a space's projectIds/sectors).
export async function retrieveAcross(
  query: string,
  scope: { projectIds?: string[]; sectors?: string[] } | undefined,
  opts?: { projects?: number; perProject?: number }
): Promise<{ project: string; card: ProjectCard | null; passages: CrossResult[] }[]> {
  const nProjects = opts?.projects ?? 5;
  const perProject = opts?.perProject ?? 3;
  const coarse = await searchCards(query, scope, nProjects);
  const projectIds = coarse.map((c) => c.project);
  if (projectIds.length === 0) return [];
  const passages = await searchProjects(query, projectIds, { k: nProjects * perProject, perProject });
  // Group passages back under their project, preserving card order.
  return projectIds.map((pid) => ({
    project: pid,
    card: getCard(pid),
    passages: passages.filter((p) => p.project === pid),
  }));
}

// MAP: extract the evidence in one project's passages that bears on the query.
// Deliberately terse — this is a compression step, not the final answer.
async function extractEvidence(query: string, project: string, card: ProjectCard | null, passages: CrossResult[]): Promise<string> {
  if (passages.length === 0) return "";
  const source = passages.map((p) => `[${p.file}] ${p.text}`).join("\n---\n");
  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 220,
    system:
      "Extract ONLY what in this single engagement's material bears on the user's question. 2–4 terse bullets, each a " +
      "transferable finding (not client-identifying trivia). If nothing is relevant, reply exactly 'NONE'. No preamble.",
    messages: [
      {
        role: "user",
        content: `Question: ${query}\n\nEngagement: ${card?.title ?? project} (${card?.sector ?? "?"})\n\nMaterial:\n${source}\n\nBullets:`,
      },
    ],
  });
  const text = response.content.find((b) => b.type === "text");
  const out = text && text.type === "text" ? text.text.trim() : "";
  return /^none$/i.test(out) ? "" : out;
}

// Full pipeline: coarse → fine → map (parallel) → reduce. Returns the synthesised
// answer plus the engagements it drew on (provenance for credibility + audit).
// `abstract` = true forces de-identified, aggregate phrasing (cross-client answers).
export async function answerAcross(
  query: string,
  scope: { projectIds?: string[]; sectors?: string[] } | undefined,
  opts?: { projects?: number; perProject?: number; abstract?: boolean; audience?: string }
): Promise<CrossAnswer> {
  const groups = await retrieveAcross(query, scope, opts);
  const extracts = await Promise.all(
    groups.map(async (g) => ({ ...g, evidence: await extractEvidence(query, g.project, g.card, g.passages) }))
  );
  const used = extracts.filter((e) => e.evidence);
  if (used.length === 0) {
    return { answer: "I couldn't find relevant evidence across the engagements in this space.", projectsUsed: [] };
  }

  // Label each engagement's evidence so the synthesiser can cite it. For abstract
  // (cross-client) answers we withhold client names and refer to engagements
  // generically ("a healthcare engagement"), so nothing identifies a client.
  const blocks = used
    .map((e, i) => {
      const label = opts?.abstract
        ? `Engagement ${i + 1} (${e.card?.sector ?? "sector n/a"}, ${e.card?.type ?? "engagement"})`
        : `${e.card?.title ?? e.project} — ${e.card?.client ?? "?"} (${e.card?.sector ?? "?"})`;
      return `## ${label}\n${e.evidence}`;
    })
    .join("\n\n");

  const guidance = opts?.abstract
    ? "This answer spans MULTIPLE CLIENTS. De-identify: never name a client, and phrase findings as firm patterns " +
      "('across our healthcare work…'). Aggregate rather than quote any single engagement. "
    : "";
  const audience = opts?.audience ? `Write for a ${opts.audience} audience. ` : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    system:
      "You synthesise a CROSS-PROJECT answer from evidence extracted from several past engagements. Ground every claim " +
      "in the evidence below — do not invent. Prefer patterns that recur across engagements, and say how many support a " +
      "claim ('seen in N of the engagements here'). Be concise and decision-useful. " +
      guidance +
      audience +
      "End with a short 'Drawn from:' line listing the engagements you used.",
    messages: [{ role: "user", content: `Question: ${query}\n\nEvidence by engagement:\n\n${blocks}\n\nAnswer:` }],
  });
  const text = response.content.find((b) => b.type === "text");
  return {
    answer: text && text.type === "text" ? text.text.trim() : "",
    projectsUsed: used.map((e) => ({
      project: e.project,
      title: e.card?.title ?? e.project,
      client: opts?.abstract ? "(withheld)" : e.card?.client ?? "?",
      sector: e.card?.sector ?? "?",
    })),
  };
}
