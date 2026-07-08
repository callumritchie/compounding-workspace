/* ---------------------------------------------------------------------------
   signals/atoms.ts — the signal-atom store (the Signal Engine's substrate).

   An ATOM is one typed, sourced, timestamped, confidence-graded observation
   extracted from an interaction transcript or a risk register — the interaction/
   temporal equivalent of a card finding, but with a verbatim evidence quote and a
   gating scope. Cards stay the coarse RETRIEVAL layer; atoms are the SIGNAL layer
   that aggregation / temporal / whitespace / the inbox all read.

   Governance is enforced here at read time: internal-transcript-derived atoms are
   scoped to their project and never surface firm-wide.
--------------------------------------------------------------------------- */

import { getDb, encodeVec } from "../db";
import { embed } from "../embed";

export type AtomType =
  | "buying"
  | "competitive"
  | "objection"
  | "unmet-need"
  | "relationship"
  | "delivery-risk"
  | "risk-entry";

export type SignalAtom = {
  id: string;
  type: AtomType | string;
  text: string;
  evidence: string;
  source: string;
  sourceKind: "client-transcript" | "internal-transcript" | "risk-register" | "doc" | string;
  project: string;
  client: string;
  sector: string;
  scope: string;
  confidence: number;
  urgency: number;
  sentiment: number | null;
  ts: string;
  week: string;
  status: string;
};

type AtomRow = {
  id: string; type: string; text: string; evidence: string; source: string; source_kind: string;
  project: string; client: string; sector: string; scope: string;
  confidence: number; urgency: number; sentiment: number | null; ts: string; week: string; status: string;
};

function rowToAtom(r: AtomRow): SignalAtom {
  return {
    id: r.id, type: r.type, text: r.text, evidence: r.evidence ?? "", source: r.source ?? "",
    sourceKind: r.source_kind ?? "doc", project: r.project ?? "", client: r.client ?? "", sector: r.sector ?? "",
    scope: r.scope ?? "", confidence: r.confidence ?? 0.5, urgency: r.urgency ?? 0.5,
    sentiment: r.sentiment ?? null, ts: r.ts ?? "", week: r.week ?? "", status: r.status ?? "new",
  };
}

// What a cross-project cluster matches on.
function atomText(a: Pick<SignalAtom, "text" | "evidence">): string {
  return [a.text, a.evidence].filter(Boolean).join(" — ");
}

// Persist atoms + their embeddings in one transaction. Idempotent per source: we
// clear any prior atoms from the same source file first, so re-running extraction
// on an updated transcript replaces rather than duplicates.
export async function insertAtoms(atoms: SignalAtom[]): Promise<void> {
  if (atoms.length === 0) return;
  const db = getDb();
  const vecs = await embed(atoms.map(atomText));
  const sources = [...new Set(atoms.map((a) => a.source))];
  db.transaction(() => {
    for (const src of sources) {
      const stale = db.prepare("SELECT id FROM signal_atoms WHERE source = ?").all(src) as { id: string }[];
      for (const { id } of stale) {
        db.prepare("DELETE FROM signal_atoms WHERE id = ?").run(id);
        db.prepare("DELETE FROM signal_atoms_vec WHERE id = ?").run(id);
      }
    }
    atoms.forEach((a, i) => {
      db.prepare(
        `INSERT OR REPLACE INTO signal_atoms
           (id,type,text,evidence,source,source_kind,project,client,sector,scope,confidence,urgency,sentiment,ts,week,status)
         VALUES (@id,@type,@text,@evidence,@source,@source_kind,@project,@client,@sector,@scope,@confidence,@urgency,@sentiment,@ts,@week,@status)`
      ).run({
        ...a, source_kind: a.sourceKind,
      });
      db.prepare("INSERT OR REPLACE INTO signal_atoms_vec (id, type, sector, embedding) VALUES (?, ?, ?, ?)").run(
        a.id, a.type, a.sector, encodeVec(vecs[i])
      );
    });
  })();
}

export type AtomFilter = {
  types?: string[]; // restrict to these atom types
  projects?: string[]; // restrict to these projects
  sourceKinds?: string[]; // e.g. only client-transcript
  excludeInternal?: boolean; // drop internal-transcript-derived atoms (firm-tier default)
  minConfidence?: number;
  status?: string; // e.g. only 'new'
};

// Scope-gated read. `excludeInternal` is the governance default for any firm-wide
// consumer: internal-team candor stays inside the engagement.
export function queryAtoms(filter: AtomFilter = {}): SignalAtom[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.types?.length) { where.push(`type IN (${filter.types.map(() => "?").join(",")})`); params.push(...filter.types); }
  if (filter.projects?.length) { where.push(`project IN (${filter.projects.map(() => "?").join(",")})`); params.push(...filter.projects); }
  if (filter.sourceKinds?.length) { where.push(`source_kind IN (${filter.sourceKinds.map(() => "?").join(",")})`); params.push(...filter.sourceKinds); }
  if (filter.excludeInternal) where.push("source_kind != 'internal-transcript'");
  if (typeof filter.minConfidence === "number") { where.push("confidence >= ?"); params.push(filter.minConfidence); }
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  const sql = `SELECT * FROM signal_atoms ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC`;
  const rows = getDb().prepare(sql).all(...params) as AtomRow[];
  return rows.map(rowToAtom);
}

export function setAtomStatus(id: string, status: string): boolean {
  const info = getDb().prepare("UPDATE signal_atoms SET status = ? WHERE id = ?").run(status, id);
  return info.changes > 0;
}

export function countAtoms(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM signal_atoms").get() as { n: number }).n;
}
