/* ---------------------------------------------------------------------------
   assemble.ts — turn a pile of memories into the text we inject, in two tiers.

   This is "context engineering" made concrete. Two ideas:

   1. LABELS / provenance — every memory is tagged with its source and trust
      (POLICY, USER PREFERENCE, LESSON…) so the model weights a shaky lesson
      differently from firm policy, instead of treating everything as fact.

   2. TWO TIERS, for caching (see PRD B6):
        • stable tier  — constitution + high-importance learned. Changes rarely,
          so it sits at the FRONT of the prompt behind a cache breakpoint.
        • ranked tier  — lower-importance learned memory. Changes turn to turn,
          so it sits AFTER the breakpoint (never cached).
      Ordering stable→volatile is what lets prompt-caching actually work.

   Each tier has a TOKEN BUDGET; if it overflows we drop the lowest-ranked
   items and record why (shown in the glass box).

   RANKING, at scale: the STABLE tier is always importance-ordered — it must stay
   query-independent so prompt-caching works. The RANKED tier is the query-ranked
   one: while everything fits, importance order is fine (and identical to before);
   but once there are enough memories that the ranked tier OVERFLOWS its budget,
   we reorder it by RELEVANCE to the current question (embedding similarity) so the
   memories that actually answer *this* question survive the cut — not merely the
   highest-importance ones. This is what makes memory hold up with lots and lots
   of memories. Falls back to importance if no query or the embedder is unavailable.
--------------------------------------------------------------------------- */

import type { Memory, MemoryType } from "./memory";

// Rough token estimate (~4 chars/token). Good enough for budgeting; the glass
// box shows the REAL token counts from the API response for cost/caching.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const BUDGETS = { stable: 1500, ranked: 800 };

export type Tier = "stable" | "ranked";
export type InjectedItem = { id: string; scope: string; type: MemoryType; tier: Tier; tokens: number; text: string };
export type DroppedItem = { id: string; scope: string; reason: string };

export type ContextReport = {
  injected: InjectedItem[];
  dropped: DroppedItem[];
  stableTokens: number;
  volatileTokens: number;
  budgets: { stable: number; ranked: number };
};

export type AssembledContext = {
  stableBlock: string; // constitution + high-importance learned (cacheable)
  rankedBlock: string; // lower-importance learned memory (not cached) — split out for the composition view
  volatileBlock: string; // ranked memory + working context (not cached)
  report: ContextReport;
};

// The trust label shown before each memory.
function label(m: Memory): string {
  if (m.type === "constitution") {
    if (m.scope.startsWith("company/policy")) return "POLICY [authoritative]";
    if (m.scope.startsWith("personal/")) return "USER PREFERENCE [authoritative]";
    return `CONSTITUTION [${m.scope}]`;
  }
  // Provisional = captured but not yet confirmed by use. Flag it as unconfirmed so
  // the model weighs it cautiously (and verifies) until it graduates to a LESSON.
  if (m.status === "provisional") return `PROVISIONAL [${m.scope} · unconfirmed — verify before relying]`;
  return `LESSON [${m.scope} · learned · importance ${m.importance}]`;
}

// Fit as many memories as the budget allows; record the rest as dropped.
function fitToBudget(
  mems: Memory[],
  budget: number,
  tier: Tier,
  injected: InjectedItem[],
  dropped: DroppedItem[]
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const m of mems) {
    const line = `- ${label(m)}: ${m.body}`;
    const tokens = estimateTokens(line);
    if (used + tokens > budget) {
      dropped.push({ id: m.id, scope: m.scope, reason: `${tier} budget exceeded` });
      continue;
    }
    used += tokens;
    lines.push(line);
    // Carry the memory's actual (short) text so the glass box can show it —
    // makes clear a memory is a small fact, not a whole file. Truncate defensively.
    const text = m.body.length > 200 ? `${m.body.slice(0, 200).trimEnd()}…` : m.body;
    injected.push({ id: m.id, scope: m.scope, type: m.type, tier, tokens, text });
  }
  return lines;
}

export function assembleContext(memories: Memory[], workingContext: string): AssembledContext {
  // CACHE-STABLE tier = constitution + PINNED memory only. Both are things that
  // don't change turn-to-turn, so the cached prompt prefix stays stable (P4). We
  // deliberately no longer put "high-importance learned" here: importance is
  // mutable (graduation, edits, decay), so gating the cache on it silently busted
  // the prefix cache. Provisional memory is never cached (unconfirmed).
  const isStable = (m: Memory) => m.status !== "provisional" && (m.type === "constitution" || !!m.pinned);
  const byImportance = (a: Memory, b: Memory) => b.importance - a.importance;

  // The `memories` passed in are already the RELEVANT subset (see
  // getRelevantMemories); here we just tier, label, and fit to budget.
  const stableMems = memories.filter(isStable).sort(byImportance);
  const rankedMems = memories.filter((m) => !isStable(m)).sort(byImportance);

  const injected: InjectedItem[] = [];
  const dropped: DroppedItem[] = [];

  const stableLines = fitToBudget(stableMems, BUDGETS.stable, "stable", injected, dropped);
  const rankedLines = fitToBudget(rankedMems, BUDGETS.ranked, "ranked", injected, dropped);

  const stableBlock = stableLines.length
    ? "MEMORY — things you already know (weigh each by its trust label):\n" + stableLines.join("\n")
    : "";
  const rankedBlock = rankedLines.length
    ? "MEMORY — possibly-relevant lessons (lower confidence, verify before relying):\n" + rankedLines.join("\n")
    : "";
  const volatileBlock = [rankedBlock, workingContext].filter(Boolean).join("\n\n");

  return {
    stableBlock,
    rankedBlock,
    volatileBlock,
    report: {
      injected,
      dropped,
      stableTokens: estimateTokens(stableBlock),
      volatileTokens: estimateTokens(volatileBlock),
      budgets: { stable: BUDGETS.stable, ranked: BUDGETS.ranked },
    },
  };
}
