/* ---------------------------------------------------------------------------
   annotations.ts — the shared human layer over surfaced insights.

   The Interrogate signal inbox is a MULTI-PLAYER, firm-wide read: everyone sees
   the same proactively surfaced insights. This module lets any teammate leave a
   natural-language note on one — extra context, a correction, or a nullification —
   that is persisted and visible to EVERYONE. Notes are keyed by the signal's
   STABLE id (e.g. 'churn:beta'), so they survive the inbox being recomputed from
   the corpus on every load.

   v1 scope: notes are shown to all, and an active 'nullify' retires the insight
   for the whole team (author + reason kept). Re-running the synthesis with a
   note's context folded in as new evidence is a deliberate fast-follow.
--------------------------------------------------------------------------- */

import { getDb, audit } from "../db";

// Two families of human input, deliberately distinct:
//   REFINE  (context | correction | nullify) — shapes the INSIGHT itself.
//   COMMENT (comment)                         — team DISCUSSION; doesn't change it.
export type AnnotationKind = "context" | "correction" | "nullify" | "comment";
export const REFINE_KINDS: AnnotationKind[] = ["context", "correction", "nullify"];

export type Annotation = {
  id: number;
  signalId: string;
  author: string;
  kind: AnnotationKind;
  body: string;
  ts: string;
};

// The per-signal rollup the inbox uses to flag an insight at a glance.
export type AnnotationRollup = {
  notes: Annotation[]; // all, for back-compat
  refinements: Annotation[]; // context/correction/nullify — shape the insight
  comments: Annotation[]; // team discussion
  count: number;
  nullified: boolean;        // an active 'nullify' exists → retire for everyone
  nullifiedBy?: string;
  nullifyReason?: string;
};

const KINDS: AnnotationKind[] = ["context", "correction", "nullify", "comment"];

// Add a note to a surfaced insight. Persisted + audited so the whole team sees it.
export function addAnnotation(input: {
  signalId: string;
  author: string;
  kind: AnnotationKind;
  body: string;
}): Annotation {
  const db = getDb();
  const ts = new Date().toISOString();
  const kind: AnnotationKind = KINDS.includes(input.kind) ? input.kind : "context";
  const body = input.body.trim();
  const info = db
    .prepare(
      "INSERT INTO signal_annotations (signal_id, author, kind, body, ts, status) VALUES (?,?,?,?,?, 'active')"
    )
    .run(input.signalId, input.author, kind, body, ts);
  audit(db, {
    actor: input.author,
    action: "signal_annotate",
    scope: "signal",
    detail: { signalId: input.signalId, kind, body: body.slice(0, 200) },
  });
  return { id: Number(info.lastInsertRowid), signalId: input.signalId, author: input.author, kind, body, ts };
}

// Every active note on one insight, oldest first.
export function listAnnotations(signalId: string): Annotation[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, signal_id AS signalId, author, kind, body, ts FROM signal_annotations WHERE status='active' AND signal_id=? ORDER BY ts ASC"
    )
    .all(signalId) as Annotation[];
}

// Roll up one insight's notes into the flags the UI needs (called after an add).
export function rollupFor(signalId: string): AnnotationRollup {
  return foldRollup(listAnnotations(signalId));
}

// Bulk fetch for the whole inbox in one query: signalId → rollup. Signals with no
// notes are simply absent from the map (the client treats missing as "open").
export function getAnnotationsFor(signalIds: string[]): Record<string, AnnotationRollup> {
  const ids = Array.from(new Set(signalIds.filter(Boolean)));
  if (ids.length === 0) return {};
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, signal_id AS signalId, author, kind, body, ts
         FROM signal_annotations
        WHERE status='active' AND signal_id IN (${placeholders})
        ORDER BY ts ASC`
    )
    .all(...ids) as Annotation[];

  const byId: Record<string, Annotation[]> = {};
  for (const r of rows) (byId[r.signalId] ??= []).push(r);
  const out: Record<string, AnnotationRollup> = {};
  for (const [signalId, notes] of Object.entries(byId)) out[signalId] = foldRollup(notes);
  return out;
}

function foldRollup(notes: Annotation[]): AnnotationRollup {
  const roll: AnnotationRollup = {
    notes,
    refinements: notes.filter((n) => REFINE_KINDS.includes(n.kind)),
    comments: notes.filter((n) => n.kind === "comment"),
    count: notes.length,
    nullified: false,
  };
  // Latest active nullify wins (notes are oldest-first, so scan to the end).
  for (const n of notes) {
    if (n.kind === "nullify") {
      roll.nullified = true;
      roll.nullifiedBy = n.author;
      roll.nullifyReason = n.body;
    }
  }
  return roll;
}
