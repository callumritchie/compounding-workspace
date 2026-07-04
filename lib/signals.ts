/* ---------------------------------------------------------------------------
   signals.ts — the implicit-signal ledger.

   Not every insight arrives as an explicit "remember this". Often a pattern
   just recurs — the agent notices the same thing a few times. This ledger lets
   those quiet, repeated observations ACCUMULATE strength, and once a pattern
   crosses a threshold it auto-creates a promotion nomination for human review.

   So there are two ways a nomination reaches the review queue:
     • explicit  — the agent calls nominate_for_promotion
     • implicit  — a pattern recurs enough here to cross the threshold

   The ledger is pruned so stale, one-off signals don't pile up forever.
   Stored as workspace/signals/ledger.json — open it and watch strength build.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { addNomination } from "./promotion";

const LEDGER = path.join(process.cwd(), "workspace", "signals", "ledger.json");

export const SIGNAL_THRESHOLD = 3; // repeats needed before a signal auto-nominates
const PRUNE_DAYS = 30; // drop signals not seen within this window

export type Signal = {
  pattern: string; // short stable key so repeats accumulate
  count: number;
  lastSeen: string;
  lastObservation: string;
  targetScope: string;
  nominated: boolean;
  sourceProject: string;
  sourceClient: string;
};

function daysSince(dateStr: string): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  return (Date.now() - then) / 86_400_000;
}

async function readLedger(): Promise<Signal[]> {
  try {
    return JSON.parse(await fs.readFile(LEDGER, "utf8")) as Signal[];
  } catch {
    return [];
  }
}

async function writeLedger(signals: Signal[]): Promise<void> {
  await fs.mkdir(path.dirname(LEDGER), { recursive: true });
  await fs.writeFile(LEDGER, JSON.stringify(signals, null, 2), "utf8");
}

export async function listSignals(): Promise<Signal[]> {
  return (await readLedger()).sort((a, b) => b.count - a.count);
}

// Record one observation of a pattern. Returns the running strength and whether
// this call crossed the threshold and created a nomination.
export async function noteSignal(input: {
  pattern: string;
  observation: string;
  targetScope: string;
  sourceProject: string;
  sourceClient: string;
}): Promise<{ count: number; threshold: number; nominatedNow: boolean }> {
  const today = new Date().toISOString().slice(0, 10);

  // Prune stale signals first, then find/create this one.
  let signals = (await readLedger()).filter((s) => daysSince(s.lastSeen) <= PRUNE_DAYS);
  let sig = signals.find((s) => s.pattern === input.pattern);
  if (!sig) {
    sig = {
      pattern: input.pattern,
      count: 0,
      lastSeen: today,
      lastObservation: input.observation,
      targetScope: input.targetScope,
      nominated: false,
      sourceProject: input.sourceProject,
      sourceClient: input.sourceClient,
    };
    signals.push(sig);
  }

  sig.count += 1;
  sig.lastSeen = today;
  sig.lastObservation = input.observation;
  sig.targetScope = input.targetScope;

  let nominatedNow = false;
  if (sig.count >= SIGNAL_THRESHOLD && !sig.nominated) {
    await addNomination({
      fact: input.observation,
      targetScope: input.targetScope,
      reason: `Recurring signal seen ${sig.count}× ("${input.pattern}")`,
      nominatedBy: "signal-ledger",
      sourceProject: input.sourceProject,
      sourceClient: input.sourceClient,
    });
    sig.nominated = true;
    nominatedNow = true;
  }

  await writeLedger(signals);
  return { count: sig.count, threshold: SIGNAL_THRESHOLD, nominatedNow };
}
