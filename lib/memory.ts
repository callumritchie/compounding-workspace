/* ---------------------------------------------------------------------------
   memory.ts — the memory store (small, curated facts the agent "just knows").

   The contrast with corpus.ts is the whole point of this project:
     • corpus  = large raw files, PULLED in on demand (RAG)
     • memory  = small distilled facts, PUSHED into every prompt

   Each memory is a markdown file with a YAML frontmatter header, grouped into
   SCOPE folders under workspace/memory/. You can open any of them in a text
   editor — this is the system's "brain", in plain sight.

     scope examples:  company/policy   company/lessons
                      project/acme-health
                      personal/alice   personal/bob

   Two TYPES cut across every scope:
     • constitution — authored, authoritative, doesn't decay (policies, prefs)
     • learned      — emergent, compounding, provenance-tracked (lessons)
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import matter from "gray-matter";
import { getProjectConfig, contextTags, type ProjectConfig } from "./project";

export type MemoryType = "constitution" | "learned";

export type Memory = {
  id: string;
  scope: string; // folder path, e.g. "company/policy"
  type: MemoryType;
  importance: number; // 0..1 (cold-start low; climbs via confirmation/promotion)
  confidential?: boolean;
  appliesTo?: Record<string, string>;
  provenance?: Record<string, unknown>;
  status?: string; // active | proposed | retracted
  body: string;
  file: string;
};

const MEM_ROOT = path.join(process.cwd(), "workspace", "memory");

// Read + parse every memory in one scope folder ([] if the folder is empty).
export async function readMemoriesInScope(scope: string): Promise<Memory[]> {
  const dir = path.join(MEM_ROOT, scope);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Memory[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    const { data, content } = matter(raw);
    if (data.status === "retracted") continue; // contested/removed — never inject
    out.push({
      id: String(data.id ?? name.replace(/\.md$/, "")),
      scope,
      type: data.type === "learned" ? "learned" : "constitution",
      importance: typeof data.importance === "number" ? data.importance : 0.3,
      confidential: Boolean(data.confidential),
      appliesTo: data.applies_to,
      provenance: data.provenance,
      status: data.status ? String(data.status) : "active",
      body: content.trim(),
      file: path.join(dir, name),
    });
  }
  return out;
}

// The scopes that apply to a user on a project, broad → specific. This is the
// scope LATTICE: company → sector → client → project → personal. A memory
// promoted to "sector/healthcare" is seen by every healthcare project.
export function scopesFor(user: string, cfg: ProjectConfig): string[] {
  return [
    "company/policy",
    "company/lessons",
    `sector/${cfg.sector}`,
    `client/${cfg.client}`,
    `project/${cfg.id}`,
    `personal/${user}`,
  ];
}

// A memory can carry an applies_to filter (e.g. {sector: healthcare}). It only
// applies when EVERY tag matches the current context. No filter = always applies.
// This is how one person's preferences can differ by project/client type without
// inventing new scopes.
export function matchesContext(mem: Memory, tags: Record<string, string>): boolean {
  if (!mem.appliesTo) return true;
  return Object.entries(mem.appliesTo).every(
    ([k, v]) => String(tags[k] ?? "").toLowerCase() === String(v).toLowerCase()
  );
}

// All in-scope, applicable memories for the current context.
export async function getMemoriesForContext(user: string, projectId: string): Promise<Memory[]> {
  const cfg = await getProjectConfig(projectId);
  const tags = contextTags(cfg);
  const groups = await Promise.all(scopesFor(user, cfg).map(readMemoriesInScope));
  return groups.flat().filter((m) => matchesContext(m, tags));
}

// Create/append a memory file. Used by the agent's "remember" tool. New learned
// memories are born at low importance (they must earn trust).
export async function writeMemory(input: {
  scope: string;
  type?: MemoryType;
  body: string;
  importance?: number;
  provenance?: Record<string, unknown>;
  appliesTo?: Record<string, string>;
}): Promise<Memory> {
  const dir = path.join(MEM_ROOT, input.scope);
  await fs.mkdir(dir, { recursive: true });
  const id = `mem_${Date.now().toString(36)}`;
  const data: Record<string, unknown> = {
    id,
    type: input.type ?? "learned",
    importance: input.importance ?? 0.2,
  };
  if (input.appliesTo) data.applies_to = input.appliesTo;
  if (input.provenance) data.provenance = input.provenance;

  const file = path.join(dir, `${id}.md`);
  await fs.writeFile(file, matter.stringify(`${input.body}\n`, data), "utf8");

  return {
    id,
    scope: input.scope,
    type: (data.type as MemoryType) ?? "learned",
    importance: data.importance as number,
    appliesTo: input.appliesTo,
    provenance: input.provenance,
    body: input.body,
    file,
  };
}

// Find a memory file within a scope by its id. Files written by the app are
// named <id>.md, but hand-authored seeds may have friendly names with the id in
// their frontmatter — so we check both.
async function findMemoryFile(scope: string, id: string): Promise<string | null> {
  const dir = path.join(MEM_ROOT, scope);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  if (names.includes(`${id}.md`)) return path.join(dir, `${id}.md`);
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const { data } = matter(await fs.readFile(path.join(dir, name), "utf8"));
    if (String(data.id ?? "") === id) return path.join(dir, name);
  }
  return null;
}

// Read one memory file, mutate its frontmatter, and save it back.
async function updateMemoryFrontmatter(
  scope: string,
  id: string,
  mutate: (data: Record<string, unknown>) => void
): Promise<boolean> {
  const file = await findMemoryFile(scope, id);
  if (!file) return false;
  const { data, content } = matter(await fs.readFile(file, "utf8"));
  mutate(data);
  await fs.writeFile(file, matter.stringify(content, data), "utf8");
  return true;
}

// Reinforcement keyed off CORRECTNESS, not usage — this is the anti-poisoning
// rule. Only LEARNED memory moves; constitution is authoritative and never
// nudged. Importance is clamped to [0, 1].
export async function reinforceMemory(scope: string, id: string, delta: number): Promise<boolean> {
  return updateMemoryFrontmatter(scope, id, (data) => {
    if (data.type === "constitution") return; // authoritative — leave untouched
    const current = typeof data.importance === "number" ? data.importance : 0.3;
    data.importance = Math.max(0, Math.min(1, Number((current + delta).toFixed(3))));
    data.last_reinforced = new Date().toISOString().slice(0, 10);
  });
}

// Contest / retract: mark a memory retracted so it stops being injected.
export async function retractMemory(scope: string, id: string): Promise<boolean> {
  return updateMemoryFrontmatter(scope, id, (data) => {
    data.status = "retracted";
  });
}
