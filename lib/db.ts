/* ---------------------------------------------------------------------------
   db.ts — the shared-memory database (SQLite, via better-sqlite3 + sqlite-vec).

   Why a database, not markdown files: this is a MULTI-PLAYER shared brain. Two
   users (or two tabs, or a fire-and-forget write racing the main turn) can touch
   the same memory at once. Loose files with read-modify-write have no way to stop
   those from interleaving — you get torn or lost writes. SQLite gives us real
   transactions, so every mutation is all-or-nothing and serialised.

   It also lets memory be RETRIEVED like the corpus: each memory carries an
   embedding (memories_vec) so we can pull the RELEVANT few for a question instead
   of pushing every in-scope memory into the prompt.

   Legibility (this project's north star) moves from "open the .md file" to the
   Memory-manager UI, which is the human window onto these tables. The git-tracked
   markdown under workspace/memory/** stays as the SEED source: an empty database
   imports it on first boot (see seed.ts).

   One file: workspace/index/workspace.db. The corpus vectors keep their own DB
   (lib/vectors.ts) — same embedding model, separate concern.
--------------------------------------------------------------------------- */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { promises as fs, mkdirSync } from "fs";
import path from "path";

export const DB_PATH = path.join(process.cwd(), "workspace", "index", "workspace.db");
export const MEM_DIM = 384; // all-MiniLM-L6-v2 (see embed.ts)

let _db: Database.Database | null = null;

// Open once per process, load sqlite-vec, create the schema. WAL mode lets reads
// proceed while a write is in flight and improves concurrency on a single server.
export function getDb(): Database.Database {
  if (_db) return _db;
  // better-sqlite3 opens synchronously; ensure the dir exists first (sync mkdir so
  // this stays a plain sync accessor callers don't have to await).
  const dir = path.dirname(DB_PATH);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  db.exec(SCHEMA);
  _db = db;
  return db;
}

// For tests: point at a throwaway DB and reset the singleton.
export function _setDbForTest(file: string): Database.Database {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  db.exec(SCHEMA);
  _db = db;
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  scope                  TEXT NOT NULL,
  id                     TEXT NOT NULL,
  type                   TEXT NOT NULL DEFAULT 'learned',   -- constitution | learned
  importance             REAL NOT NULL DEFAULT 0.3,
  status                 TEXT NOT NULL DEFAULT 'active',    -- active | provisional | retracted
  pinned                 INTEGER NOT NULL DEFAULT 0,
  confidential           INTEGER NOT NULL DEFAULT 0,
  applies_to             TEXT,                              -- JSON object or NULL
  provenance             TEXT,                              -- JSON object or NULL
  body                   TEXT NOT NULL,
  use_count              INTEGER NOT NULL DEFAULT 0,
  used_since_provisional INTEGER NOT NULL DEFAULT 0,
  last_used              TEXT,
  last_reinforced        TEXT,
  created                TEXT,
  PRIMARY KEY (scope, id)                                  -- memories are addressed by (scope, id)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);

-- Vector index keyed by "scope::id" (vec0 needs a single-column key). "scope" is
-- a metadata column so relevance search can be filtered to in-scope memories
-- inside the DB — the scope lattice stays the retrieval boundary.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  vid       TEXT PRIMARY KEY,
  scope     TEXT,
  embedding float[${MEM_DIM}] distance_metric=cosine
);

CREATE TABLE IF NOT EXISTS signals (
  pattern          TEXT PRIMARY KEY,
  count            INTEGER NOT NULL DEFAULT 0,
  last_seen        TEXT,
  last_observation TEXT,
  target_scope     TEXT,
  nominated        INTEGER NOT NULL DEFAULT 0,
  source_project   TEXT,
  source_client    TEXT
);

CREATE TABLE IF NOT EXISTS promotions (
  id             TEXT PRIMARY KEY,
  fact           TEXT,
  target_scope   TEXT,
  reason         TEXT,
  nominated_by   TEXT,
  source_project TEXT,
  source_client  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | promoted | rejected
  created        TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id             TEXT PRIMARY KEY,
  fact           TEXT,
  scope          TEXT,
  proposed_by    TEXT,
  source_project TEXT,
  created        TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  actor     TEXT,
  action    TEXT NOT NULL,
  scope     TEXT,
  memory_id TEXT,
  detail    TEXT                                   -- JSON: before/after or notes
);
CREATE INDEX IF NOT EXISTS idx_audit_memory ON audit_log(memory_id);

-- Project summary "cards": a compact, generated digest of each engagement (what it
-- was, key findings, outcome). They're the COARSE layer of cross-project retrieval —
-- a firm-wide question finds relevant PROJECTS via their cards first, then drills
-- into those projects' chunks (see lib/cards.ts, lib/retrieval.ts).
CREATE TABLE IF NOT EXISTS project_cards (
  project      TEXT PRIMARY KEY,
  client       TEXT,
  sector       TEXT,
  type         TEXT,
  status       TEXT,
  title        TEXT,
  summary      TEXT,
  key_findings TEXT,                               -- JSON string[]
  outcome      TEXT,
  updated      TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS cards_vec USING vec0(
  project   TEXT PRIMARY KEY,
  sector    TEXT,
  embedding float[${MEM_DIM}] distance_metric=cosine
);

-- Knowledge-reuse events (ticket C1): every time a piece of firm knowledge learned
-- ELSEWHERE (a shared-scope learned memory) is applied on a DIFFERENT project, we
-- log it. This is the compounding the old way-of-working could never measure — the
-- leadership impact metric ("N insights reused across M engagements").
CREATE TABLE IF NOT EXISTS reuse_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  memory_id      TEXT,
  scope          TEXT,
  source_project TEXT,                             -- where the insight was learned
  target_project TEXT,                             -- where it was reused
  actor          TEXT
);
CREATE INDEX IF NOT EXISTS idx_reuse_memory ON reuse_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_reuse_target ON reuse_events(target_project);

-- Signal ATOMS (the Signal Engine): typed, sourced, timestamped, confidence-graded
-- observations extracted from interaction transcripts + risk registers. This is the
-- new signal LAYER that sits between raw corpus and the consumers (cards stay the
-- coarse RETRIEVAL layer). Aggregation / temporal / whitespace / the inbox all read
-- atoms. NB: the older 'signals' table above is the unrelated memory usage-tracker.
CREATE TABLE IF NOT EXISTS signal_atoms (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                          -- buying | competitive | objection | unmet-need | relationship | delivery-risk | risk-entry
  text        TEXT NOT NULL,                          -- the atom, one sentence
  evidence    TEXT,                                   -- VERBATIM quote from the source
  source      TEXT,                                   -- file path it came from
  source_kind TEXT,                                   -- client-transcript | internal-transcript | risk-register | doc
  project     TEXT,
  client      TEXT,
  sector      TEXT,
  scope       TEXT,                                   -- gating scope (internal-derived stays project/<id>)
  confidence  REAL NOT NULL DEFAULT 0.5,              -- 0..1 — soft-signal grading
  urgency     REAL NOT NULL DEFAULT 0.5,              -- 0..1 — perishability
  sentiment   REAL,                                   -- -1..1 for relationship/health atoms (else NULL)
  ts          TEXT,                                   -- ISO timestamp of the interaction (freshness)
  week        TEXT,                                   -- risk-register week label (temporal ordering)
  status      TEXT NOT NULL DEFAULT 'new'             -- new | reviewed | actioned | dismissed
);
CREATE INDEX IF NOT EXISTS idx_atoms_project ON signal_atoms(project);
CREATE INDEX IF NOT EXISTS idx_atoms_type ON signal_atoms(type);
CREATE VIRTUAL TABLE IF NOT EXISTS signal_atoms_vec USING vec0(
  id        TEXT PRIMARY KEY,
  type      TEXT,
  sector    TEXT,
  embedding float[${MEM_DIM}] distance_metric=cosine
);

-- Human notes on surfaced insights (the Interrogate "correct / sharpen / nullify"
-- layer). Keyed by the SIGNAL's stable id (e.g. 'churn:beta') so a note survives the
-- inbox being recomputed each load. SHARED: every user sees every active note, and a
-- 'nullify' retires the insight for the whole team (with author + reason kept for
-- audit). This is the collaborative editing surface — one team, one shared read.
CREATE TABLE IF NOT EXISTS signal_annotations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL,                          -- stable inbox signal id
  author    TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'context',        -- context | correction | nullify
  body      TEXT NOT NULL,                          -- the natural-language note
  ts        TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active'          -- active | withdrawn
);
CREATE INDEX IF NOT EXISTS idx_annotations_signal ON signal_annotations(signal_id);

-- In-project FINDINGS feedback (the proactive "Findings" surface). Findings are
-- recomputed on demand from the engagement's own state, so — like the annotations
-- above — feedback is keyed by the finding's STABLE id (e.g. 'rr:acme-health:budget')
-- and read back at build time. This is what makes a dismiss actually stick (the old
-- inbox dismiss was a no-op on derived signals) and what lets the surface LEARN:
--   • dismissed  + reason 'wrong'        → retire the finding for the whole team
--   • dismissed  + reason 'not-relevant' → mute it for this user (and its class)
--   • snoozed    ('not-now')             → hide until snooze_until, then re-surface
--   • accepted / saved                   → positive signal the ranker reinforces
CREATE TABLE IF NOT EXISTS finding_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id   TEXT NOT NULL,                        -- stable finding id
  kind         TEXT NOT NULL,                        -- finding kind (for class-level learning)
  project      TEXT,
  actor        TEXT NOT NULL,
  response     TEXT NOT NULL,                        -- accepted | saved | dismissed | snoozed
  reason       TEXT,                                 -- not-relevant | wrong | not-now (on dismiss/snooze)
  snooze_until TEXT,                                 -- ISO — set when response = 'snoozed'
  ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finding_feedback_fid ON finding_feedback(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_feedback_proj ON finding_feedback(project);

-- STORED findings — the LLM-detected kinds (ungrounded-claim from the faithfulness
-- judge on an answer; contradiction from an upload). Unlike the deterministic
-- detectors (rising-risk / unanswered-objective, recomputed live from state), these
-- are point-in-time judgements, so they're persisted with a stable id and merged
-- into buildFindings alongside the live ones. Dismissal rides the same
-- finding_feedback table, keyed by this id.
CREATE TABLE IF NOT EXISTS stored_findings (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  kind       TEXT NOT NULL,                        -- ungrounded-claim | contradiction
  title      TEXT NOT NULL,
  detail     TEXT,
  evidence   TEXT,                                 -- JSON [{quote,source}]
  confidence REAL NOT NULL DEFAULT 0.6,
  urgency    REAL NOT NULL DEFAULT 0.6,
  trigger    TEXT,
  action     TEXT,                                 -- JSON {title,prompt} or NULL
  ts         TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open'          -- open | superseded
);
CREATE INDEX IF NOT EXISTS idx_stored_findings_project ON stored_findings(project);
`;

// sqlite-vec takes an embedding as a JSON array string.
export function encodeVec(vec: number[]): string {
  return JSON.stringify(vec);
}

// The composite key used in memories_vec (vec0 needs one column).
export function vid(scope: string, id: string): string {
  return `${scope}::${id}`;
}

// Append an audit entry. Callers pass it the SAME transaction-bound db so the log
// and the mutation commit together (or not at all).
export function audit(
  db: Database.Database,
  entry: { actor?: string; action: string; scope?: string; memoryId?: string; detail?: unknown }
): void {
  db.prepare(
    "INSERT INTO audit_log (ts, actor, action, scope, memory_id, detail) VALUES (?,?,?,?,?,?)"
  ).run(
    new Date().toISOString(),
    entry.actor ?? null,
    entry.action,
    entry.scope ?? null,
    entry.memoryId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail)
  );
}

// Has the store been seeded yet? (Used by seed.ts to import markdown on first boot.)
export function isEmpty(): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
  return row.n === 0;
}

// Best-effort: keep the file-existence check handy for scripts.
export async function dbFileExists(): Promise<boolean> {
  return fs
    .access(DB_PATH)
    .then(() => true)
    .catch(() => false);
}
