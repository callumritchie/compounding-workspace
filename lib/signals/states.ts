/* ---------------------------------------------------------------------------
   signals/states.ts — the lifecycle of a surfaced insight.

   The feed mostly RECOMPUTES, so an insight self-sunsets when its underlying
   signals change (a mitigated risk stops surfacing). This thin layer handles the
   part that must survive recompute: what the TEAM did with an insight.

     • owned     — someone's on it (stays in the feed, badged with the owner)
     • resolved  — dealt with → leaves the active feed, kept in HISTORY (never deleted)
     • snoozed   — hidden until a date, then it returns
     • reopened  — undo a close

   Keyed by the insight's stable id, append-only; the latest row per id is current.
   Plus a decay read (`isAged`) that folds away stale, low-value, untouched cards —
   but never a high-value one (high confidence / owned / engaged is always kept).
--------------------------------------------------------------------------- */

import { getDb, audit } from "../db";

export type SignalState = "owned" | "resolved" | "snoozed" | "reopened";
export type CurrentState = { state: SignalState; actor: string; note?: string; snoozeUntil?: string; ts: string };

const STATES: SignalState[] = ["owned", "resolved", "snoozed", "reopened"];

export function setSignalState(input: {
  signalId: string;
  actor: string;
  state: SignalState;
  note?: string;
  snoozeDays?: number;
}): CurrentState {
  const db = getDb();
  const ts = new Date().toISOString();
  const state: SignalState = STATES.includes(input.state) ? input.state : "owned";
  const snoozeUntil = state === "snoozed" ? new Date(Date.now() + (input.snoozeDays ?? 7) * 86_400_000).toISOString() : null;
  db.prepare("INSERT INTO signal_state (signal_id, actor, state, note, snooze_until, ts) VALUES (?,?,?,?,?,?)").run(
    input.signalId, input.actor, state, input.note ?? null, snoozeUntil, ts
  );
  audit(db, { actor: input.actor, action: "signal_state", scope: "signal", detail: { signalId: input.signalId, state } });
  return { state, actor: input.actor, note: input.note, snoozeUntil: snoozeUntil ?? undefined, ts };
}

type Row = { signal_id: string; actor: string; state: SignalState; note: string | null; snooze_until: string | null; ts: string };

// The current (latest) state for each of the given ids. Ids with no row are "active".
export function currentStates(signalIds: string[]): Record<string, CurrentState> {
  const ids = Array.from(new Set(signalIds.filter(Boolean)));
  if (!ids.length) return {};
  const rows = getDb()
    .prepare(`SELECT signal_id, actor, state, note, snooze_until, ts FROM signal_state WHERE signal_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts ASC`)
    .all(...ids) as Row[];
  const out: Record<string, CurrentState> = {};
  for (const r of rows) out[r.signal_id] = { state: r.state, actor: r.actor, note: r.note ?? undefined, snoozeUntil: r.snooze_until ?? undefined, ts: r.ts }; // latest wins (ASC)
  return out;
}

// Should this insight be HIDDEN from the active feed right now?
//   resolved → yes (in History); snoozed → yes until the window passes; else no.
export function isHidden(cur: CurrentState | undefined): boolean {
  if (!cur) return false;
  if (cur.state === "resolved") return true;
  if (cur.state === "snoozed") return !cur.snoozeUntil || new Date(cur.snoozeUntil).getTime() > Date.now();
  return false; // owned / reopened stay visible
}

// Decay: fold away a card that's gone stale AND low-value AND untouched. Value is
// protected — a confident, owned, or annotated insight is never aged out.
export function isAged(input: { ageDays?: number; score: number; confidence: number; state?: CurrentState; hasNotes?: boolean }): boolean {
  const AGE_FOLD = 30;
  const SCORE_FLOOR = 0.3;
  if (input.confidence >= 0.7) return false; // high-value: keep
  if (input.state || input.hasNotes) return false; // engaged: keep
  return (input.ageDays ?? 0) > AGE_FOLD && input.score < SCORE_FLOOR;
}

// History — resolved/nullified insights, most recent first (nothing is deleted; this
// is what will later feed the decision-quality plane: what we flagged, what happened).
export function listResolved(limit = 100): { signalId: string; actor: string; state: string; note?: string; ts: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT s.signal_id, s.actor, s.state, s.note, s.ts FROM signal_state s
        JOIN (SELECT signal_id, MAX(ts) mx FROM signal_state GROUP BY signal_id) l
          ON s.signal_id = l.signal_id AND s.ts = l.mx
       WHERE s.state = 'resolved' ORDER BY s.ts DESC LIMIT ?`
    )
    .all(limit) as Row[];
  return rows.map((r) => ({ signalId: r.signal_id, actor: r.actor, state: r.state, note: r.note ?? undefined, ts: r.ts }));
}
