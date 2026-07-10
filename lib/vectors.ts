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
import { chunkDocument, composeChunk, type Chunk } from "./chunk";
import { embed, embedOne, countTokens, MAX_EMBED_TOKENS } from "./embed";

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
  // Keyword arm of hybrid search: an FTS5 index over the SAME chunk text, giving us
  // BM25 term matching for the exact names / figures / acronyms the embedder blurs
  // (client names, "RPM", a specific $ figure). vec = meaning, fts = words; we fuse
  // the two rankings (reciprocal-rank fusion) so a passage wins if EITHER arm ranks
  // it well. chunk_id/project/file are UNINDEXED metadata we filter + join on.
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
       chunk_id UNINDEXED, project UNINDEXED, file UNINDEXED, text
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
  const chunks = await enforceTokenBudget(chunkDocument(body));
  const pieces = chunks.map(composeChunk);
  const embeddings = await embed(pieces);
  return pieces.map((text, i) => ({
    chunk_id: `${project}:${file}#${i}`,
    project,
    file,
    text,
    embedding: encode(embeddings[i]),
  }));
}

// Guarantee no chunk exceeds the embedder's window: measure real tokens and split
// any over-budget chunk (char-proportional, re-stamping its heading breadcrumb)
// until every piece fits. char sizing gets prose right; this catches the dense
// outliers (wide tables, code) that char count alone can't.
async function enforceTokenBudget(chunks: Chunk[]): Promise<Chunk[]> {
  const tokens = await countTokens(chunks.map(composeChunk));
  const out: Chunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (tokens[i] <= MAX_EMBED_TOKENS) out.push(chunks[i]);
    else out.push(...(await splitToBudget(chunks[i], tokens[i])));
  }
  return out;
}

async function splitToBudget(chunk: Chunk, tokenCount: number): Promise<Chunk[]> {
  const n = Math.max(2, Math.ceil((tokenCount / MAX_EMBED_TOKENS) * 1.15)); // margin
  const size = Math.ceil(chunk.text.length / n);
  const parts: Chunk[] = [];
  for (let i = 0; i < chunk.text.length; i += size) {
    parts.push({ crumb: chunk.crumb, text: chunk.text.slice(i, i + size).trim() });
  }
  // Verify; recurse on the rare piece still over budget (e.g. no whitespace to break on).
  const toks = await countTokens(parts.map(composeChunk));
  const out: Chunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].text) continue;
    if (toks[i] <= MAX_EMBED_TOKENS) out.push(parts[i]);
    else out.push(...(await splitToBudget(parts[i], toks[i])));
  }
  return out;
}

// Ensure the directory exists before better-sqlite3 opens the file.
async function ensureDir(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

function insertRows(db: Database.Database, rows: Row[]): void {
  const vstmt = db.prepare(
    "INSERT INTO vec_chunks(chunk_id, project, file, text, embedding) VALUES (@chunk_id, @project, @file, @text, @embedding)"
  );
  const fstmt = db.prepare(
    "INSERT INTO fts_chunks(chunk_id, project, file, text) VALUES (@chunk_id, @project, @file, @text)"
  );
  const tx = db.transaction((rs: Row[]) =>
    rs.forEach((r) => {
      vstmt.run(r);
      fstmt.run({ chunk_id: r.chunk_id, project: r.project, file: r.file, text: r.text });
    })
  );
  tx(rows);
}

// Rebuild the whole index from every file in every project.
export async function buildIndex(): Promise<number> {
  await ensureDir();
  const db = getDb();
  db.exec("DELETE FROM vec_chunks;");
  db.exec("DELETE FROM fts_chunks;");
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
  db.prepare("DELETE FROM fts_chunks WHERE project = ? AND file = ?").run(project, file);
  const rows = await chunkAndEmbed(project, file);
  insertRows(db, rows);
  return rows.length;
}

// A candidate chunk from one arm of the search, carrying its rank in that arm.
type Cand = { chunk_id: string; project: string; file: string; text: string };

// Turn a raw user question into a safe FTS5 MATCH expression: bag-of-words OR'd
// together, each term quoted so punctuation/operators in the query can't break the
// FTS grammar. OR (not AND) maximises recall — the fusion + rerank downstream sort
// out precision. Returns "" when there's nothing searchable (→ keyword arm skipped).
function ftsMatch(query: string): string {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/gi) ?? []).filter((t) => t.length > 1);
  return terms.length ? Array.from(new Set(terms)).map((t) => `"${t}"`).join(" OR ") : "";
}

// The semantic arm: KNN by embedding, best-first. (project = null → whole corpus.)
function semanticArm(db: Database.Database, qvec: string, k: number, project: string | null): Cand[] {
  const sql = project
    ? `SELECT chunk_id, project, file, text FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND project = ? ORDER BY distance`
    : `SELECT chunk_id, project, file, text FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`;
  const params = project ? [qvec, k, project] : [qvec, k];
  return db.prepare(sql).all(...params) as Cand[];
}

// The keyword arm: BM25 over the same chunks, best-first (bm25() is lower=better).
function keywordArm(db: Database.Database, query: string, k: number, project: string | null): Cand[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const sql = project
    ? `SELECT chunk_id, project, file, text FROM fts_chunks WHERE fts_chunks MATCH ? AND project = ? ORDER BY bm25(fts_chunks) LIMIT ?`
    : `SELECT chunk_id, project, file, text FROM fts_chunks WHERE fts_chunks MATCH ? ORDER BY bm25(fts_chunks) LIMIT ?`;
  const params = project ? [match, project, k] : [match, k];
  try {
    return db.prepare(sql).all(...params) as Cand[];
  } catch {
    return []; // a malformed MATCH should never take down retrieval
  }
}

// Reciprocal-rank fusion: a chunk's score is Σ 1/(RRF_K + rank) across the arms it
// appears in (rank is 1-based, best = 1). Rank-based fusion needs no score
// calibration between the two very different scales (cosine vs BM25) and rewards
// passages that BOTH arms like. Returns fused candidates, best-first, with a score
// normalised to [0, 1] (1 ⇒ ranked #1 by both arms).
const RRF_K = 60;
function fuse(arms: Cand[][], k: number): SearchResult2[] {
  const acc = new Map<string, { cand: Cand; score: number }>();
  for (const arm of arms) {
    arm.forEach((cand, i) => {
      const prev = acc.get(cand.chunk_id);
      const add = 1 / (RRF_K + i + 1);
      if (prev) prev.score += add;
      else acc.set(cand.chunk_id, { cand, score: add });
    });
  }
  const maxScore = arms.length / (RRF_K + 1); // both arms rank #1
  return Array.from(acc.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ cand, score }) => ({ ...cand, score: Math.min(1, score / maxScore) }));
}

type SearchResult2 = Cand & { score: number };

// Top-k HYBRID search within one project: semantic ⊕ keyword, fused. The wide-net
// pool per arm is a few × k so fusion has something to work with; the reranker
// above this (in the semantic_search tool) then picks the final passages.
export async function search(query: string, project: string, k = 5): Promise<SearchResult[]> {
  await ensureDir();
  const db = getDb();
  const qvec = encode(await embedOne(query));
  const pool = Math.max(k * 3, 12);
  const fused = fuse([semanticArm(db, qvec, pool, project), keywordArm(db, query, pool, project)], k);
  return fused.map((r) => ({ file: r.file, text: r.text, score: r.score }));
}

export type CrossResult = SearchResult & { project: string };

// Cross-project HYBRID search — the fine layer of cross-project retrieval.
//   • projectIds = null  → search the WHOLE corpus (firm-wide).
//   • projectIds = [...]  → per-project hybrid (perProject cap each) then merge by
//     fused score. Per-project retrieval + a cap is what gives BREADTH across
//     engagements rather than depth in one verbose project. Callers typically pass
//     the top projects from searchCards() first.
export async function searchProjects(
  query: string,
  projectIds: string[] | null,
  opts?: { k?: number; perProject?: number }
): Promise<CrossResult[]> {
  await ensureDir();
  const db = getDb();
  const qvec = encode(await embedOne(query));
  const k = opts?.k ?? 12;
  const perProject = opts?.perProject ?? 3;

  if (!projectIds) {
    const pool = Math.max(k * 3, 18);
    const fused = fuse([semanticArm(db, qvec, pool, null), keywordArm(db, query, pool, null)], k);
    return fused.map((r) => ({ project: r.project, file: r.file, text: r.text, score: r.score }));
  }

  const merged: CrossResult[] = [];
  for (const project of projectIds) {
    const pool = Math.max(perProject * 3, 9);
    const fused = fuse([semanticArm(db, qvec, pool, project), keywordArm(db, query, pool, project)], perProject);
    for (const r of fused) merged.push({ project: r.project, file: r.file, text: r.text, score: r.score });
  }
  return merged.sort((a, b) => b.score - a.score).slice(0, k);
}
