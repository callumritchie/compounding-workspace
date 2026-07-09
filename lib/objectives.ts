/* ---------------------------------------------------------------------------
   objectives.ts — the engagement's NORTH STAR, as always-on context.

   Every project is signed off against a statement of work, and the few objectives
   distilled from it are the thing the whole engagement steers by. Unlike the
   engagement's hard constraints (budget / timeline / scope — see engagement.ts),
   the objectives answer "what does success look like?". They're STANDING context:
   they bear on every recommendation, so — like the engagement digest — they're
   read from a per-project `files/objectives.md` and pushed into the prompt every
   turn rather than left to RAG (which only surfaces on match).

   objectives.md is a plain, human-authored markdown doc: a short intro plus a
   bullet (or numbered) list. We parse the list deterministically — no LLM, so it
   can't drift — and render a compact digest. Kept a SEPARATE file (not folded into
   engagement.md) so it reads clearly as the signed-off north star.
--------------------------------------------------------------------------- */

import { readFile } from "./corpus";

export const OBJECTIVES_FILE = "objectives.md";

// Parse the markdown list (bullets `-`/`*` or numbers `1.`/`1)`) into objective
// strings. Non-list prose (the intro line, headings) is ignored, so authors can
// write a readable doc and still get a clean list back.
export async function getObjectives(projectId: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await readFile(projectId, OBJECTIVES_FILE);
  } catch {
    return null;
  }
  const items: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)/);
    if (m) items.push(m[1].trim().replace(/\*\*/g, ""));
  }
  return items.length ? items : null;
}

// The compact, always-on block. Framed so the agent keeps work in service of the
// objectives and flags drift, mirroring the engagementDigest voice.
export function objectivesDigest(objectives: string[]): string {
  if (!objectives.length) return "";
  return [
    "PROJECT OBJECTIVES (the signed-off north star for this engagement — keep every recommendation in service of these; if the work drifts from them, say so in one line):",
    ...objectives.map((o) => `- ${o}`),
  ].join("\n");
}
