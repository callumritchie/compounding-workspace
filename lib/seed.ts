/* ---------------------------------------------------------------------------
   seed.ts — import the git-tracked markdown seeds into the database.

   The markdown under workspace/memory/** is the canonical SEED source (demo
   fixtures, version-controlled). The database is the runtime source of truth.
   On first boot (empty DB) we import the seeds once; thereafter every write goes
   to the DB. `reseed()` wipes + reimports (used by the demo reset + npm run
   db:reseed) so the demo can always return to a known baseline.

   Also imports the existing JSON stores (signals ledger, promotion queue,
   proposals) so nothing already on disk is lost when the DB is first created.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import matter from "gray-matter";
import { getDb, encodeVec, vid, isEmpty } from "./db";
import { embed } from "./embed";

const MEM_ROOT = path.join(process.cwd(), "workspace", "memory");

type SeedMem = {
  id: string;
  scope: string;
  type: string;
  importance: number;
  status: string;
  pinned: number;
  confidential: number;
  applies_to: string | null;
  provenance: string | null;
  body: string;
  used_since_provisional: number;
  use_count: number;
  last_used: string | null;
  last_reinforced: string | null;
  created: string | null;
};

// Walk workspace/memory/** collecting memory .md files (skip _proposals /
// _promotion_queue internal folders).
async function collectSeedFiles(): Promise<SeedMem[]> {
  const out: SeedMem[] = [];
  async function walk(rel: string): Promise<void> {
    const dir = path.join(MEM_ROOT, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("_")) continue; // internal (promotion queue, proposals)
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const { data, content } = matter(await fs.readFile(path.join(dir, e.name), "utf8"));
      const prov = (data.provenance ?? {}) as Record<string, unknown>;
      out.push({
        id: String(data.id ?? e.name.replace(/\.md$/, "")),
        scope: rel.split(path.sep).join("/"),
        type: data.type === "learned" ? "learned" : "constitution",
        importance: typeof data.importance === "number" ? data.importance : 0.3,
        status: data.status ? String(data.status) : "active",
        pinned: data.pinned ? 1 : 0,
        confidential: data.confidential ? 1 : 0,
        applies_to: data.applies_to ? JSON.stringify(data.applies_to) : null,
        provenance: data.provenance ? JSON.stringify(data.provenance) : null,
        body: content.trim(),
        used_since_provisional: typeof data.used_since_provisional === "number" ? data.used_since_provisional : 0,
        use_count: typeof data.use_count === "number" ? data.use_count : 0,
        last_used: data.last_used ? String(data.last_used) : null,
        last_reinforced: data.last_reinforced ? String(data.last_reinforced) : null,
        created: prov.created ? String(prov.created) : null,
      });
    }
  }
  await walk("");
  return out;
}

// Import legacy JSON stores (signals / promotions / proposals) if present.
async function importJsonStores(): Promise<void> {
  const db = getDb();
  // Signals ledger
  try {
    const ledger = JSON.parse(await fs.readFile(path.join(MEM_ROOT, "..", "signals", "ledger.json"), "utf8")) as Array<{
      pattern: string; count: number; lastSeen?: string; lastObservation?: string; targetScope?: string; nominated?: boolean; sourceProject?: string; sourceClient?: string;
    }>;
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO signals (pattern,count,last_seen,last_observation,target_scope,nominated,source_project,source_client) VALUES (?,?,?,?,?,?,?,?)"
    );
    db.transaction(() => ledger.forEach((s) => stmt.run(s.pattern, s.count, s.lastSeen ?? null, s.lastObservation ?? null, s.targetScope ?? null, s.nominated ? 1 : 0, s.sourceProject ?? null, s.sourceClient ?? null)))();
  } catch { /* none */ }
  // Promotion queue
  try {
    const dir = path.join(MEM_ROOT, "_promotion_queue");
    const names = await fs.readdir(dir);
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO promotions (id,fact,target_scope,reason,nominated_by,source_project,source_client,status,created) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const p = JSON.parse(await fs.readFile(path.join(dir, n), "utf8"));
      stmt.run(p.id, p.fact ?? null, p.targetScope ?? null, p.reason ?? null, p.nominatedBy ?? null, p.sourceProject ?? null, p.sourceClient ?? null, p.status ?? "pending", p.created ?? null);
    }
  } catch { /* none */ }
  // Proposals
  try {
    const dir = path.join(MEM_ROOT, "_proposals");
    const names = await fs.readdir(dir);
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO proposals (id,fact,scope,proposed_by,source_project,created) VALUES (?,?,?,?,?,?)"
    );
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const p = JSON.parse(await fs.readFile(path.join(dir, n), "utf8"));
      stmt.run(p.id, p.fact ?? null, p.scope ?? null, p.proposedBy ?? null, p.sourceProject ?? null, p.created ?? null);
    }
  } catch { /* none */ }
}

// Insert all seed memories + their embeddings in one transaction.
async function importMemories(mems: SeedMem[]): Promise<void> {
  if (mems.length === 0) return;
  const db = getDb();
  const vectors = await embed(mems.map((m) => m.body)); // one batched embed call
  const memStmt = db.prepare(
    `INSERT OR REPLACE INTO memories
       (id,scope,type,importance,status,pinned,confidential,applies_to,provenance,body,use_count,used_since_provisional,last_used,last_reinforced,created)
     VALUES (@id,@scope,@type,@importance,@status,@pinned,@confidential,@applies_to,@provenance,@body,@use_count,@used_since_provisional,@last_used,@last_reinforced,@created)`
  );
  const vecStmt = db.prepare("INSERT OR REPLACE INTO memories_vec (vid, embedding) VALUES (?, ?)");
  db.transaction(() => {
    mems.forEach((m, i) => {
      memStmt.run(m);
      vecStmt.run(vid(m.scope, m.id), encodeVec(vectors[i]));
    });
  })();
}

// Import seeds only if the store is empty (first boot). Idempotent + fast to skip.
let _seeded = false;
export async function ensureSeeded(): Promise<void> {
  if (_seeded) return;
  if (!isEmpty()) {
    _seeded = true;
    return;
  }
  await importMemories(await collectSeedFiles());
  await importJsonStores();
  _seeded = true;
}

// Wipe + reimport from the markdown seeds (demo reset / npm run db:reseed).
export async function reseed(): Promise<number> {
  const db = getDb();
  db.exec("DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM signals; DELETE FROM promotions; DELETE FROM proposals;");
  const mems = await collectSeedFiles();
  await importMemories(mems);
  await importJsonStores();
  _seeded = true;
  return mems.length;
}
