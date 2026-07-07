/* ---------------------------------------------------------------------------
   signals.ts — the implicit-signal ledger (now a database table).

   Not every insight arrives as an explicit "remember this". Often a pattern just
   recurs — the agent notices the same thing a few times. This ledger lets those
   quiet, repeated observations ACCUMULATE strength, and once a pattern crosses a
   threshold it auto-creates a promotion nomination for human review.

   Two ways a nomination reaches the review queue:
     • explicit  — the agent calls nominate_for_promotion
     • implicit  — a pattern recurs enough here to cross the threshold

   Moved off a single JSON file (which was rewritten wholesale on every note — a
   lost-update race under concurrency) onto a transactional table.
--------------------------------------------------------------------------- */

import { getDb } from "./db";
import { ensureSeeded } from "./seed";
import { addNomination } from "./promotion";

export const SIGNAL_THRESHOLD = 3; // repeats needed before a signal auto-nominates
const PRUNE_DAYS = 30; // drop signals not seen within this window

export type Signal = {
  pattern: string;
  count: number;
  lastSeen: string;
  lastObservation: string;
  targetScope: string;
  nominated: boolean;
  sourceProject: string;
  sourceClient: string;
};

type Row = {
  pattern: string;
  count: number;
  last_seen: string | null;
  last_observation: string | null;
  target_scope: string | null;
  nominated: number;
  source_project: string | null;
  source_client: string | null;
};

function rowToSignal(r: Row): Signal {
  return {
    pattern: r.pattern,
    count: r.count,
    lastSeen: r.last_seen ?? "",
    lastObservation: r.last_observation ?? "",
    targetScope: r.target_scope ?? "",
    nominated: !!r.nominated,
    sourceProject: r.source_project ?? "",
    sourceClient: r.source_client ?? "",
  };
}

function daysSince(dateStr: string): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  return (Date.now() - then) / 86_400_000;
}

export async function listSignals(): Promise<Signal[]> {
  await ensureSeeded();
  const rows = getDb().prepare("SELECT * FROM signals ORDER BY count DESC").all() as Row[];
  return rows.map(rowToSignal);
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
  await ensureSeeded();
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();

  // Prune stale signals, then upsert this one — all in one transaction so a
  // concurrent note can't interleave and lose the increment.
  const result = db.transaction(() => {
    // prune
    const all = db.prepare("SELECT pattern, last_seen FROM signals").all() as { pattern: string; last_seen: string | null }[];
    for (const s of all) {
      if (s.last_seen && daysSince(s.last_seen) > PRUNE_DAYS) db.prepare("DELETE FROM signals WHERE pattern = ?").run(s.pattern);
    }
    const existing = db.prepare("SELECT * FROM signals WHERE pattern = ?").get(input.pattern) as Row | undefined;
    const count = (existing?.count ?? 0) + 1;
    const alreadyNominated = !!existing?.nominated;
    db.prepare(
      `INSERT INTO signals (pattern,count,last_seen,last_observation,target_scope,nominated,source_project,source_client)
         VALUES (@pattern,@count,@last_seen,@obs,@scope,@nominated,@project,@client)
       ON CONFLICT(pattern) DO UPDATE SET
         count=@count, last_seen=@last_seen, last_observation=@obs, target_scope=@scope`
    ).run({
      pattern: input.pattern,
      count,
      last_seen: today,
      obs: input.observation,
      scope: input.targetScope,
      nominated: alreadyNominated ? 1 : 0,
      project: input.sourceProject,
      client: input.sourceClient,
    });
    return { count, alreadyNominated };
  })();

  // Cross the threshold → nominate (outside the sync txn; addNomination is async).
  let nominatedNow = false;
  if (result.count >= SIGNAL_THRESHOLD && !result.alreadyNominated) {
    await addNomination({
      fact: input.observation,
      targetScope: input.targetScope,
      reason: `Recurring signal seen ${result.count}× ("${input.pattern}")`,
      nominatedBy: "signal-ledger",
      sourceProject: input.sourceProject,
      sourceClient: input.sourceClient,
    });
    db.prepare("UPDATE signals SET nominated = 1 WHERE pattern = ?").run(input.pattern);
    nominatedNow = true;
  }

  return { count: result.count, threshold: SIGNAL_THRESHOLD, nominatedNow };
}
