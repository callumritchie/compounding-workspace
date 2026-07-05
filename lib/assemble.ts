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
   items and record why (shown in the glass box). Ranking here is deliberately
   "dumb" — just importance — until the eval harness shows we need more.
--------------------------------------------------------------------------- */

import type { Memory, MemoryType } from "./memory";

// Rough token estimate (~4 chars/token). Good enough for budgeting; the glass
// box shows the REAL token counts from the API response for cost/caching.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const BUDGETS = { stable: 1500, ranked: 800 };
const STABLE_IMPORTANCE = 0.7; // learned memory this important rides in the stable tier

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
  const isStable = (m: Memory) => m.type === "constitution" || m.importance >= STABLE_IMPORTANCE;
  const byImportance = (a: Memory, b: Memory) => b.importance - a.importance;

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
