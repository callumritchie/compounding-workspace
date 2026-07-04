/* ---------------------------------------------------------------------------
   vectors.ts — the vector store, kept as simple as possible on purpose.

   It's just a JSON array of {file, text, embedding}, and search is a plain
   brute-force cosine comparison you can read in one function. At demo scale
   (hundreds of chunks) this is instant and completely legible — no database,
   no black box. (The "one notch up" would be sqlite-vec; same idea, on disk.)

   This is the RAG arm: text is chunked, embedded, and PULLED on demand by
   similarity — the opposite of memory, which is pushed in every turn.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { listProjects, listFiles, readFile } from "./corpus";
import { chunkText } from "./chunk";
import { embed, embedOne } from "./embed";

const INDEX = path.join(process.cwd(), "workspace", "index", "vectors.json");

export type IndexedChunk = { id: string; project: string; file: string; text: string; embedding: number[] };
export type SearchResult = { file: string; text: string; score: number };

// Cosine similarity. Vectors are already unit-length (see embed.ts), so this
// dot product IS the cosine.
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export async function loadIndex(): Promise<IndexedChunk[]> {
  try {
    return JSON.parse(await fs.readFile(INDEX, "utf8")) as IndexedChunk[];
  } catch {
    return [];
  }
}

async function saveIndex(chunks: IndexedChunk[]): Promise<void> {
  await fs.mkdir(path.dirname(INDEX), { recursive: true });
  await fs.writeFile(INDEX, JSON.stringify(chunks), "utf8");
}

// Chunk + embed one file into indexed chunks.
async function chunkAndEmbed(project: string, file: string): Promise<IndexedChunk[]> {
  const pieces = chunkText(await readFile(project, file));
  const embeddings = await embed(pieces);
  return pieces.map((text, i) => ({ id: `${project}:${file}#${i}`, project, file, text, embedding: embeddings[i] }));
}

// Rebuild the whole index from every file in every project.
export async function buildIndex(): Promise<number> {
  const all: IndexedChunk[] = [];
  for (const project of await listProjects()) {
    for (const file of await listFiles(project)) {
      all.push(...(await chunkAndEmbed(project, file)));
    }
  }
  await saveIndex(all);
  return all.length;
}

// Add (or replace) one file in the index — used after an upload.
export async function addFileToIndex(project: string, file: string): Promise<number> {
  const kept = (await loadIndex()).filter((c) => !(c.project === project && c.file === file));
  const fresh = await chunkAndEmbed(project, file);
  await saveIndex([...kept, ...fresh]);
  return fresh.length;
}

// Brute-force top-k search within one project.
export async function search(query: string, project: string, k = 5): Promise<SearchResult[]> {
  const index = (await loadIndex()).filter((c) => c.project === project);
  if (index.length === 0) return [];
  const q = await embedOne(query);
  return index
    .map((c) => ({ file: c.file, text: c.text, score: cosine(q, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
