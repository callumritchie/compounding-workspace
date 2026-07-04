/* ---------------------------------------------------------------------------
   corpus.ts — the SHARED file store (the "filing cabinet").

   Unlike chat history (which is private per user), the corpus is shared: if
   Alice's agent writes a file, Bob sees it too. Files live under
   workspace/projects/<projectId>/files/ as plain text/markdown you can open.

   Four operations — list, read, search, write — mirror the four tools we hand
   the agent in tools.ts. Everything is path-safe: nothing can read or write
   outside the project's files/ folder.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

// For Phase 1 we have a single demo project. (Multi-project comes later.)
export const DEFAULT_PROJECT = "acme-health";

function filesRoot(projectId: string): string {
  return path.join(process.cwd(), "workspace", "projects", projectId, "files");
}

// Every project folder under workspace/projects (used by the project switcher).
export async function listProjects(): Promise<string[]> {
  const dir = path.join(process.cwd(), "workspace", "projects");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// Resolve a user/agent-supplied relative path and REFUSE anything that escapes
// the project's files/ folder (e.g. "../../etc/passwd"). This is the safety gate.
function safeResolve(projectId: string, relPath: string): string {
  const root = filesRoot(projectId);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path "${relPath}" is outside the project folder`);
  }
  return resolved;
}

// List every file in the project, as forward-slash relative paths (sorted).
export async function listFiles(projectId: string): Promise<string[]> {
  const root = filesRoot(projectId);
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // folder doesn't exist yet
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

// Read one file's full text.
export async function readFile(projectId: string, relPath: string): Promise<string> {
  return fs.readFile(safeResolve(projectId, relPath), "utf8");
}

// Write (create or overwrite) one file, making parent folders as needed.
export async function writeFile(
  projectId: string,
  relPath: string,
  content: string
): Promise<void> {
  const target = safeResolve(projectId, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

// A single search hit: which file, which line, and the line's text.
export type SearchHit = { file: string; line: number; text: string };

// Plain keyword search across the corpus: case-insensitive, matches lines that
// contain ANY of the query's words. Deliberately simple (no embeddings here —
// that's the vector-RAG arm in a later phase). Capped so results stay readable.
export async function searchFiles(
  projectId: string,
  query: string,
  limit = 20
): Promise<SearchHit[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const file of await listFiles(projectId)) {
    const lines = (await readFile(projectId, file)).split("\n");
    lines.forEach((text, i) => {
      const low = text.toLowerCase();
      if (words.some((w) => low.includes(w))) {
        hits.push({ file, line: i + 1, text: text.trim() });
      }
    });
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}
