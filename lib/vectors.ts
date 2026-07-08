/* ---------------------------------------------------------------------------
   vectors.ts — the vector store, now a real embedded vector database.

   This is the RAG arm: corpus text is chunked, embedded, and PULLED on demand by
   similarity (the opposite of memory, which is pushed in every turn). It used to
   be a JSON file scanned by brute force; it's now sqlite-vec — a SQLite extension
   that stores the vectors on disk and does the nearest-neighbour search + metadata
   filtering inside the database. Still one local file, no server, no API key — but
   it's how production RAG actually works: an ANN index you query, not a blob you
   load into memory. The store lives at workspace/index/vectors.db.

   The public surface (search / addFileToIndex / buildIndex / cosine) is unchanged,
   so everything above it — the semantic_search tool, uploads, the eval — is
   untouched by the swap.
--------------------------------------------------------------------------- */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { promises as fs } from "fs";
import path from "path";
import matter from "gray-matter";
import { listProjects, listFiles, readFile } from "./corpus";
import { chunkText } from "./chunk";
import { embed, embedOne } from "./embed";

const DB_PATH = path.join(process.cwd(), "workspace", "index", "vectors.db");
const DIM = 384; // all-MiniLM-L6-v2 (see embed.ts)

export type SearchResult = { file: string; text: string; score: number };

// Cosine similarity of two vectors. Kept as a plain exported helper because the
// MEMORY subsystem (lib/assemble ranking, lib/lifecycle dedupe) uses it directly
// over its own in-memory embeddings — that's separate from this corpus DB.
// Embeddings from embed.ts are unit length, so the dot product IS the cosine.
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// One connection per process, opened lazily. Loads the sqlite-vec extension and
// creates the table on first use. The vec0 virtual table holds the embedding plus
// metadata columns (project, file — filterable inside a KNN query) and an
// auxiliary text column (returned with results, prefixed "+"). cosine distance so
// score = 1 - distance lands in [0, 1] (the x-ray's "sim %").
let _db: Database.Database | null = null;
function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
       chunk_id TEXT PRIMARY KEY,
       project TEXT,
       file TEXT,
       +text TEXT,
       embedding float[${DIM}] distance_metric=cosine
     );`
  );
  _db = db;
  return db;
}

// sqlite-vec accepts an embedding as a JSON array string — legible, and plenty
// fast at this scale (a Float32 BLOB is the perf alternative if the corpus grows).
function encode(vec: number[]): string {
  return JSON.stringify(vec);
}

// Chunk + embed one file into rows ready to insert.
type Row = { chunk_id: string; project: string; file: string; text: string; embedding: string };
async function chunkAndEmbed(project: string, file: string): Promise<Row[]> {
  // Strip YAML frontmatter before chunking so structured metadata (e.g. the
  // engagement brief's constraints block) doesn't pollute the retrieved passages —
  // only the human-readable body should be searchable. gray-matter leaves plain
  // markdown untouched, so this is a no-op for ordinary corpus files.
  const raw = await readFile(project, file);
  const body = file.endsWith(".md") ? matter(raw).content : raw;
  const pieces = chunkText(body);
  const embeddings = await embed(pieces);
  return pieces.map((text, i) => ({
    chunk_id: `${project}:${file}#${i}`,
    project,
    file,
    text,
    embedding: encode(embeddings[i]),
  }));
}

// Ensure the directory exists before better-sqlite3 opens the file.
async function ensureDir(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

function insertRows(db: Database.Database, rows: Row[]): void {
  const stmt = db.prepare(
    "INSERT INTO vec_chunks(chunk_id, project, file, text, embedding) VALUES (@chunk_id, @project, @file, @text, @embedding)"
  );
  const tx = db.transaction((rs: Row[]) => rs.forEach((r) => stmt.run(r)));
  tx(rows);
}

// Rebuild the whole index from every file in every project.
export async function buildIndex(): Promise<number> {
  await ensureDir();
  const db = getDb();
  db.exec("DELETE FROM vec_chunks;");
  let total = 0;
  for (const project of await listProjects()) {
    for (const file of await listFiles(project)) {
      const rows = await chunkAndEmbed(project, file);
      insertRows(db, rows);
      total += rows.length;
    }
  }
  return total;
}

// Add (or replace) one file in the index — used after an upload. An upsert:
// drop the file's old chunks, insert the fresh ones.
export async function addFileToIndex(project: string, file: string): Promise<number> {
  await ensureDir();
  const db = getDb();
  db.prepare("DELETE FROM vec_chunks WHERE project = ? AND file = ?").run(project, file);
  const rows = await chunkAndEmbed(project, file);
  insertRows(db, rows);
  return rows.length;
}

// Top-k semantic search within one project. The KNN + project filter both run
// inside the database now (no load-everything-then-filter). distance is cosine
// distance, so score = 1 - distance is the similarity in [0, 1].
export async function search(query: string, project: string, k = 5): Promise<SearchResult[]> {
  await ensureDir();
  const db = getDb();
  const q = encode(await embedOne(query));
  const rows = db
    .prepare(
      `SELECT file, text, distance FROM vec_chunks
       WHERE embedding MATCH ? AND k = ? AND project = ?
       ORDER BY distance`
    )
    .all(q, k, project) as { file: string; text: string; distance: number }[];
  return rows.map((r) => ({ file: r.file, text: r.text, score: 1 - r.distance }));
}

export type CrossResult = SearchResult & { project: string };

// Cross-project semantic search — the fine layer of cross-project retrieval.
//   • projectIds = null  → search the WHOLE corpus (firm-wide).
//   • projectIds = [...]  → per-project KNN (perProject cap each) then merge by
//     score. Per-project retrieval + a cap is what gives BREADTH across engagements
//     rather than depth in the one verbose project (the "diversity" problem at
//     scale). Callers typically pass the top projects from searchCards() first.
export async function searchProjects(
  query: string,
  projectIds: string[] | null,
  opts?: { k?: number; perProject?: number }
): Promise<CrossResult[]> {
  await ensureDir();
  const db = getDb();
  const q = encode(await embedOne(query));
  const k = opts?.k ?? 12;
  const perProject = opts?.perProject ?? 3;

  if (!projectIds) {
    const rows = db
      .prepare(`SELECT project, file, text, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(q, k) as { project: string; file: string; text: string; distance: number }[];
    return rows.map((r) => ({ project: r.project, file: r.file, text: r.text, score: 1 - r.distance }));
  }

  const stmt = db.prepare(
    `SELECT project, file, text, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND project = ? ORDER BY distance`
  );
  const merged: CrossResult[] = [];
  for (const project of projectIds) {
    const rows = stmt.all(q, perProject, project) as { project: string; file: string; text: string; distance: number }[];
    for (const r of rows) merged.push({ project: r.project, file: r.file, text: r.text, score: 1 - r.distance });
  }
  return merged.sort((a, b) => b.score - a.score).slice(0, k);
}
