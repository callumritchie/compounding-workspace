/* ---------------------------------------------------------------------------
   reuse.ts — measuring the compounding (tickets C1, C2).

   The consulting tool's impact was "invisible to leadership" because a per-project
   efficiency gain just looks like the project finishing. The thing the old way of
   working could NEVER do is REUSE: an insight learned on engagement A applied on
   engagement B. That's attributable and countable — and it's the real story of the
   firm getting smarter each engagement.

   A reuse event = a shared-scope LEARNED memory (something learned elsewhere, above
   the current project on the lattice) injected into a DIFFERENT project's answer.
--------------------------------------------------------------------------- */

import { getDb } from "./db";

export type ReuseRef = {
  memoryId: string;
  scope: string;
  sourceProject: string | null; // where it was learned (from provenance), if known
  targetProject: string; // where it's being reused now
  actor: string;
};

// Record cross-project reuse (fire-and-forget from the chat route).
export function recordReuse(events: ReuseRef[]): void {
  if (events.length === 0) return;
  const db = getDb();
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO reuse_events (ts, memory_id, scope, source_project, target_project, actor) VALUES (?,?,?,?,?,?)"
  );
  db.transaction(() => events.forEach((e) => stmt.run(ts, e.memoryId, e.scope, e.sourceProject, e.targetProject, e.actor)))();
}

export type ReuseStats = {
  totalReuses: number;
  distinctInsights: number;
  targetProjects: number;
  topInsights: { memoryId: string; scope: string; reuses: number; targets: number }[];
  byMonth: { month: string; reuses: number }[];
};

// The leadership dashboard numbers (ticket C2).
export function reuseStats(): ReuseStats {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT memory_id) AS insights, COUNT(DISTINCT target_project) AS targets FROM reuse_events`
    )
    .get() as { total: number; insights: number; targets: number };
  const top = db
    .prepare(
      `SELECT memory_id AS memoryId, scope, COUNT(*) AS reuses, COUNT(DISTINCT target_project) AS targets
       FROM reuse_events GROUP BY memory_id ORDER BY reuses DESC LIMIT 8`
    )
    .all() as { memoryId: string; scope: string; reuses: number; targets: number }[];
  const byMonth = db
    .prepare(
      `SELECT substr(ts,1,7) AS month, COUNT(*) AS reuses FROM reuse_events GROUP BY month ORDER BY month`
    )
    .all() as { month: string; reuses: number }[];
  return {
    totalReuses: totals.total ?? 0,
    distinctInsights: totals.insights ?? 0,
    targetProjects: totals.targets ?? 0,
    topInsights: top,
    byMonth,
  };
}
