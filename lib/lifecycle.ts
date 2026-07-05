/* ---------------------------------------------------------------------------
   lifecycle.ts — "what should I clean up?" for the memory library.

   After a lot of project work the library grows. Two automatic checks surface
   candidates for tidying (they only SUGGEST — nothing is changed on disk until
   you click Archive):

     • stale       — a learned memory that's low priority AND hasn't been used
                     or reinforced in a long time (probably no longer relevant)
     • duplicates  — two learned memories whose meaning is near-identical
                     (embedding cosine over a threshold) — candidates to merge

   Only LEARNED, active memories are considered; constitution is authored and
   authoritative, so it's never proposed for archiving.
--------------------------------------------------------------------------- */

import { listAllMemories } from "./memory";
import { embed } from "./embed";
import { cosine } from "./vectors";

const STALE_DAYS = 30;
const DUP_THRESHOLD = 0.85;

export type StaleItem = {
  scope: string;
  id: string;
  body: string;
  importance: number;
  lastActivity: string;
  days: number;
};
type DupRef = { scope: string; id: string; body: string };
export type DupPair = { a: DupRef; b: DupRef; score: number };

export async function computeLifecycle(): Promise<{ stale: StaleItem[]; duplicates: DupPair[] }> {
  const all = await listAllMemories();
  const active = all.filter((m) => m.type === "learned" && (m.status ?? "active") !== "retracted");

  // Stale: low priority + no recent activity. If we have no date at all for a
  // memory we can't judge its age, so we leave it alone (avoid false positives).
  const stale: StaleItem[] = [];
  for (const m of active) {
    if (m.importance >= 0.4) continue; // only Low-priority memories are candidates
    const times = [m.lastUsed, m.lastReinforced, m.created]
      .filter(Boolean)
      .map((d) => Date.parse(d as string))
      .filter((n) => !Number.isNaN(n));
    if (times.length === 0) continue;
    const mostRecent = Math.max(...times);
    const days = (Date.now() - mostRecent) / 86_400_000;
    if (days > STALE_DAYS) {
      stale.push({
        scope: m.scope,
        id: m.id,
        body: m.body,
        importance: m.importance,
        lastActivity: new Date(mostRecent).toISOString().slice(0, 10),
        days: Math.round(days),
      });
    }
  }
  stale.sort((a, b) => b.days - a.days);

  // Near-duplicates: embed every active learned body once, compare all pairs.
  const duplicates: DupPair[] = [];
  if (active.length >= 2) {
    const embs = await embed(active.map((m) => m.body));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const score = cosine(embs[i], embs[j]);
        if (score > DUP_THRESHOLD) {
          duplicates.push({
            a: { scope: active[i].scope, id: active[i].id, body: active[i].body },
            b: { scope: active[j].scope, id: active[j].id, body: active[j].body },
            score: Number(score.toFixed(3)),
          });
        }
      }
    }
    duplicates.sort((a, b) => b.score - a.score);
  }

  return { stale, duplicates };
}
