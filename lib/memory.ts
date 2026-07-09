/* ---------------------------------------------------------------------------
   memory.ts — the memory store (small, curated facts the agent "just knows").

   The contrast with corpus.ts is the whole point of this project:
     • corpus  = large raw files, PULLED in on demand (RAG)
     • memory  = small distilled facts, SELECTED and injected into the prompt

   Memory now lives in a SQLite database (lib/db.ts) rather than one file per
   memory. Why: this is a multi-player shared brain — concurrent writes to loose
   files tore or lost updates; the database gives real transactions. Each memory
   also carries an embedding (memories_vec) so the RELEVANT few can be retrieved
   for a question instead of pushing every in-scope memory. The git-tracked
   markdown under workspace/memory/** stays as the SEED source (see lib/seed.ts);
   the human window onto the live store is the Memory-manager UI.

   Two TYPES cut across every scope:
     • constitution — authored, authoritative, doesn't decay (policies, prefs)
     • learned      — emergent, compounding, provenance-tracked (lessons)
--------------------------------------------------------------------------- */

import { getDb, encodeVec, vid, audit } from "./db";
import { ensureSeeded } from "./seed";
import { embed, embedOne } from "./embed";
import { getProjectConfig, contextTags, type ProjectConfig } from "./project";

export type MemoryType = "constitution" | "learned";

export type Memory = {
  id: string;
  scope: string; // lattice path, e.g. "company/policy"
  type: MemoryType;
  importance: number; // 0..1 (cold-start low; up via confirmation, down via decay)
  confidential?: boolean;
  pinned?: boolean; // deliberately kept in the always-on cached tier (see assemble.ts)
  appliesTo?: Record<string, string>;
  provenance?: Record<string, unknown>;
  status?: string; // active | provisional | retracted
  useCount?: number;
  lastUsed?: string;
  lastReinforced?: string;
  created?: string;
  body: string;
  file: string; // synthetic "scope/id" label (kept for backwards compatibility)
};

type Row = {
  scope: string;
  id: string;
  type: string;
  importance: number;
  status: string;
  pinned: number;
  confidential: number;
  applies_to: string | null;
  provenance: string | null;
  body: string;
  use_count: number;
  used_since_provisional: number;
  last_used: string | null;
  last_reinforced: string | null;
  created: string | null;
};

function rowToMemory(r: Row): Memory {
  return {
    id: r.id,
    scope: r.scope,
    type: r.type === "learned" ? "learned" : "constitution",
    importance: typeof r.importance === "number" ? r.importance : 0.3,
    confidential: !!r.confidential,
    pinned: !!r.pinned,
    appliesTo: r.applies_to ? (JSON.parse(r.applies_to) as Record<string, string>) : undefined,
    provenance: r.provenance ? (JSON.parse(r.provenance) as Record<string, unknown>) : undefined,
    status: r.status,
    useCount: r.use_count,
    lastUsed: r.last_used ?? undefined,
    lastReinforced: r.last_reinforced ?? undefined,
    created: r.created ?? undefined,
    body: r.body,
    file: `${r.scope}/${r.id}`,
  };
}

// Read every active (non-retracted) memory in one scope.
export async function readMemoriesInScope(scope: string): Promise<Memory[]> {
  await ensureSeeded();
  const rows = getDb()
    .prepare("SELECT * FROM memories WHERE scope = ? AND status != 'retracted'")
    .all(scope) as Row[];
  return rows.map(rowToMemory);
}

// The scopes that apply to a user on a project, broad → specific. This is the
// scope LATTICE: company → sector → client → stakeholder → project → personal.
export function scopesFor(user: string, cfg: ProjectConfig): string[] {
  return [
    "company/policy",
    "company/lessons",
    `sector/${cfg.sector}`,
    `client/${cfg.client}`,
    ...cfg.stakeholders.map((s) => `stakeholder/${s.id}`),
    `project/${cfg.id}`,
    `personal/${user}`,
  ];
}

// A memory can carry an applies_to filter (e.g. {sector: healthcare}). It only
// applies when EVERY tag matches the current context. No filter = always applies.
export function matchesContext(mem: Memory, tags: Record<string, string>): boolean {
  if (!mem.appliesTo) return true;
  return Object.entries(mem.appliesTo).every(
    ([k, v]) => String(tags[k] ?? "").toLowerCase() === String(v).toLowerCase()
  );
}

// All in-scope, applicable memories for the current context. `query` is accepted
// for relevance-ranked retrieval (see getRelevantMemories in retrieval.ts); this
// base function returns the full applicable set (used where everything is wanted,
// e.g. the kickoff brief).
export async function getMemoriesForContext(user: string, projectId: string): Promise<Memory[]> {
  await ensureSeeded();
  const cfg = await getProjectConfig(projectId);
  const tags = contextTags(cfg);
  const scopes = scopesFor(user, cfg);
  const placeholders = scopes.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE status != 'retracted' AND scope IN (${placeholders})`)
    .all(...scopes) as Row[];
  return rows.map(rowToMemory).filter((m) => matchesContext(m, tags));
}

// Relevance-selected memories for a turn (P5: memory retrieved like the corpus).
// The scope lattice stays the ACCESS boundary — we never retrieve across it — but
// WITHIN scope we pull the RELEVANT few rather than pushing everything:
//   • constitution + pinned  → always included (policy / deliberately always-on)
//   • learned                → top-K by embedding similarity to the question,
//                              scored per scope (a per-scope cap) via memories_vec.
// This is what makes memory hold up with lots and lots of memories. With no query
// (or no embedder) it falls back to importance order.
export async function getRelevantMemories(
  user: string,
  projectId: string,
  query: string,
  opts?: { perScope?: number }
): Promise<Memory[]> {
  await ensureSeeded();
  const cfg = await getProjectConfig(projectId);
  const tags = contextTags(cfg);
  const scopes = scopesFor(user, cfg);
  const perScope = opts?.perScope ?? 5;
  const db = getDb();

  // Everything in-scope + applicable (the candidate set), split by whether it's
  // always-in (constitution/pinned) or relevance-ranked (learned).
  const placeholders = scopes.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM memories WHERE status != 'retracted' AND scope IN (${placeholders})`)
    .all(...scopes) as Row[];
  const applicable = rows.map(rowToMemory).filter((m) => matchesContext(m, tags));
  const always = applicable.filter((m) => m.type === "constitution" || m.pinned);
  const learned = applicable.filter((m) => !(m.type === "constitution" || m.pinned));
  if (learned.length === 0 || !query.trim()) {
    return [...always, ...learned.sort((a, b) => b.importance - a.importance)];
  }

  // Rank the learned candidates by relevance to the question. Per-scope KNN keeps
  // the lattice boundary in the DB and gives a natural per-scope cap.
  let qvec: number[];
  try {
    qvec = await embedOne(query);
  } catch {
    return [...always, ...learned.sort((a, b) => b.importance - a.importance)];
  }
  const q = JSON.stringify(qvec);
  const dist = new Map<string, number>(); // vid -> distance
  const knn = db.prepare(
    "SELECT vid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? AND scope = ? ORDER BY distance"
  );
  for (const scope of new Set(learned.map((m) => m.scope))) {
    const hits = knn.all(q, perScope, scope) as { vid: string; distance: number }[];
    for (const h of hits) dist.set(h.vid, h.distance);
  }
  const ranked = learned
    .filter((m) => dist.has(vid(m.scope, m.id)))
    .sort((a, b) => (dist.get(vid(a.scope, a.id))! - dist.get(vid(b.scope, b.id))!));
  return [...always, ...ranked];
}

// Create a memory. New learned memories are born at low importance (they must earn
// trust). A memory can be born "provisional" (still injected, flagged unconfirmed
// until it earns trust through use — see graduateOnUse).
export async function writeMemory(input: {
  scope: string;
  type?: MemoryType;
  body: string;
  importance?: number;
  status?: string;
  pinned?: boolean;
  confidential?: boolean;
  provenance?: Record<string, unknown>;
  appliesTo?: Record<string, string>;
}): Promise<Memory> {
  await ensureSeeded();
  const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const created = new Date().toISOString().slice(0, 10);
  const provenance = { ...(input.provenance ?? {}) } as Record<string, unknown>;
  if (!provenance.created) provenance.created = created;
  const vec = await embedOne(input.body);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (scope,id,type,importance,status,pinned,confidential,applies_to,provenance,body,used_since_provisional,created)
       VALUES (@scope,@id,@type,@importance,@status,@pinned,@confidential,@applies_to,@provenance,@body,@usp,@created)`
    ).run({
      scope: input.scope,
      id,
      type: input.type ?? "learned",
      importance: input.importance ?? 0.2,
      status: input.status ?? "active",
      pinned: input.pinned ? 1 : 0,
      confidential: input.confidential ? 1 : 0,
      applies_to: input.appliesTo ? JSON.stringify(input.appliesTo) : null,
      provenance: JSON.stringify(provenance),
      body: input.body,
      usp: input.status === "provisional" ? 0 : 0,
      created,
    });
    db.prepare("INSERT OR REPLACE INTO memories_vec (vid, scope, embedding) VALUES (?, ?, ?)").run(vid(input.scope, id), input.scope, encodeVec(vec));
    audit(db, { actor: String(provenance.origin_user ?? "agent"), action: "create", scope: input.scope, memoryId: id, detail: { body: input.body, status: input.status ?? "active" } });
  })();

  return {
    id,
    scope: input.scope,
    type: input.type ?? "learned",
    importance: input.importance ?? 0.2,
    status: input.status ?? "active",
    pinned: !!input.pinned,
    confidential: !!input.confidential,
    appliesTo: input.appliesTo,
    provenance,
    created,
    body: input.body,
    file: `${input.scope}/${id}`,
  };
}

// Does a memory row exist? (helper)
function getRow(scope: string, id: string): Row | undefined {
  return getDb().prepare("SELECT * FROM memories WHERE scope = ? AND id = ?").get(scope, id) as Row | undefined;
}

// Edit a memory from the manager: any of body / importance / status / pinned.
// Importance is clamped to [0,1]; body changes re-embed. Every edit is audited.
export async function updateMemory(
  scope: string,
  id: string,
  patch: { body?: string; importance?: number; status?: string; pinned?: boolean; actor?: string }
): Promise<boolean> {
  const before = getRow(scope, id);
  if (!before) return false;
  const sets: string[] = [];
  const params: Record<string, unknown> = { scope, id };
  if (typeof patch.importance === "number") {
    sets.push("importance = @importance");
    params.importance = Math.max(0, Math.min(1, Number(patch.importance.toFixed(3))));
  }
  if (patch.status) {
    sets.push("status = @status");
    params.status = patch.status;
  }
  if (typeof patch.pinned === "boolean") {
    sets.push("pinned = @pinned");
    params.pinned = patch.pinned ? 1 : 0;
  }
  let newVec: number[] | null = null;
  if (patch.body !== undefined) {
    sets.push("body = @body");
    params.body = patch.body.trim();
    newVec = await embedOne(patch.body.trim());
  }
  if (sets.length === 0) return true;
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE scope = @scope AND id = @id`).run(params);
    if (newVec) db.prepare("INSERT OR REPLACE INTO memories_vec (vid, scope, embedding) VALUES (?, ?, ?)").run(vid(scope, id), scope, encodeVec(newVec));
    audit(db, { actor: patch.actor, action: "update", scope, memoryId: id, detail: { patch, from: { importance: before.importance, status: before.status } } });
  })();
  return true;
}

// Contest / retract: mark a memory retracted so it stops being injected.
export async function retractMemory(scope: string, id: string, actor?: string): Promise<boolean> {
  return updateMemory(scope, id, { status: "retracted", actor });
}

// Permanently delete a memory (and its vector).
export async function deleteMemory(scope: string, id: string, actor?: string): Promise<boolean> {
  const before = getRow(scope, id);
  if (!before) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM memories WHERE scope = ? AND id = ?").run(scope, id);
    db.prepare("DELETE FROM memories_vec WHERE vid = ?").run(vid(scope, id));
    audit(db, { actor, action: "delete", scope, memoryId: id, detail: { body: before.body } });
  })();
  return true;
}

/* --- Memory manager: browse the whole library (incl. retracted) ----------- */
export async function listAllMemories(): Promise<Memory[]> {
  await ensureSeeded();
  const rows = getDb().prepare("SELECT * FROM memories").all() as Row[];
  return rows.map(rowToMemory);
}

// The Memory-manager view: NOT the whole library, but everything that applies to
// THIS user in THIS engagement. The scope lattice is the access boundary —
// personal memory is only ever the current user's, project memory is only the
// current project's, and the broader tiers (company / sector / client /
// stakeholder) are those the current project inherits. Reuses scopesFor() so the
// manager can never expose another person's private notes or another engagement's
// working memory. Unlike getMemoriesForContext this KEEPS retracted rows (the
// manager is where you browse + restore archived memory) and does NOT apply the
// appliesTo filter (a lead curates every in-scope entry, not just the ones that
// match the current tags this turn).
export async function listMemoriesForManager(user: string, projectId: string): Promise<Memory[]> {
  await ensureSeeded();
  const cfg = await getProjectConfig(projectId);
  const scopes = scopesFor(user, cfg);
  const placeholders = scopes.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE scope IN (${placeholders})`)
    .all(...scopes) as Row[];
  return rows.map(rowToMemory);
}

// Outcome-based reinforcement (ticket C3). Importance should move on CORRECTNESS,
// not usage — so when a recommendation that leaned on a memory is marked as having
// worked (or not), we adjust the memory here. Worked → importance up (and stamp
// reinforced); didn't → importance down. This is the trustworthy signal leadership
// can bet on, decoupled from raw injection counts. Audited as an "outcome" event.
export async function reinforceOutcome(scope: string, id: string, worked: boolean, actor?: string): Promise<boolean> {
  await ensureSeeded();
  const db = getDb();
  const before = db.prepare("SELECT importance FROM memories WHERE scope = ? AND id = ?").get(scope, id) as
    | { importance: number }
    | undefined;
  if (!before) return false;
  const delta = worked ? 0.1 : -0.15;
  const next = Math.max(0.05, Math.min(1, Number((before.importance + delta).toFixed(3))));
  const today = new Date().toISOString().slice(0, 10);
  db.transaction(() => {
    db.prepare("UPDATE memories SET importance = ?, last_reinforced = ? WHERE scope = ? AND id = ?").run(next, today, scope, id);
    audit(db, { actor: actor ?? "outcome", action: "outcome", scope, memoryId: id, detail: { worked, from: before.importance, to: next } });
  })();
  return true;
}

// The audit trail for one memory: every create/update/retract/delete/graduate/
// decay logged against it, newest first. This is what makes a shared memory
// accountable — you can see who changed what, and when.
export type AuditEntry = { ts: string; actor: string | null; action: string; detail: unknown };
export async function memoryHistory(scope: string, id: string): Promise<AuditEntry[]> {
  await ensureSeeded();
  const rows = getDb()
    .prepare("SELECT ts, actor, action, detail FROM audit_log WHERE memory_id = ? AND scope = ? ORDER BY id DESC")
    .all(id, scope) as { ts: string; actor: string | null; action: string; detail: string | null }[];
  return rows.map((r) => ({
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    detail: r.detail ? safeParse(r.detail) : null,
  }));
}
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Record that these memories were actually injected this turn: bump use_count and
// stamp last_used. This is the USAGE signal — it powers "most-used" sorting and
// staleness detection. It deliberately does NOT touch importance (usage is not
// correctness — see graduateOnUse / decay).
export async function recordMemoryUse(refs: { scope: string; id: string }[]): Promise<void> {
  if (refs.length === 0) return;
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare("UPDATE memories SET use_count = use_count + 1, last_used = ? WHERE scope = ? AND id = ?");
  db.transaction(() => refs.forEach((r) => stmt.run(today, r.scope, r.id)))();
}

// Snooze a stale memory: touch last_used to now so it drops off the "suggest
// archiving" list without bumping its usefulness score.
export async function touchMemory(scope: string, id: string): Promise<boolean> {
  const r = getRow(scope, id);
  if (!r) return false;
  getDb().prepare("UPDATE memories SET last_used = ? WHERE scope = ? AND id = ?").run(new Date().toISOString().slice(0, 10), scope, id);
  return true;
}

// How many times a provisional memory must be injected before it graduates.
export const GRADUATION_THRESHOLD = 3;

// Graduate provisional memories through USE. For each provisional memory injected
// this turn, bump its counter; once leaned on enough times without being retracted
// first, flip it to "active". NOTE: graduation only changes STATUS (provisional →
// active) — it does not raise importance. Usage is not correctness, so it must not
// make a memory more heavily weighted (that's what confirmation/promotion do).
export async function graduateOnUse(refs: { scope: string; id: string }[]): Promise<void> {
  if (refs.length === 0) return;
  const db = getDb();
  db.transaction(() => {
    for (const r of refs) {
      const row = db.prepare("SELECT status, used_since_provisional FROM memories WHERE scope = ? AND id = ?").get(r.scope, r.id) as
        | { status: string; used_since_provisional: number }
        | undefined;
      if (!row || row.status !== "provisional") continue;
      const seen = (row.used_since_provisional ?? 0) + 1;
      if (seen >= GRADUATION_THRESHOLD) {
        db.prepare("UPDATE memories SET status = 'active', used_since_provisional = ? WHERE scope = ? AND id = ?").run(seen, r.scope, r.id);
        audit(db, { actor: "system", action: "graduate", scope: r.scope, memoryId: r.id, detail: { seen } });
      } else {
        db.prepare("UPDATE memories SET used_since_provisional = ? WHERE scope = ? AND id = ?").run(seen, r.scope, r.id);
      }
    }
  })();
}
