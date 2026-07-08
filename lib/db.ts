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
