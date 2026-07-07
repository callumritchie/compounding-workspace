/* ---------------------------------------------------------------------------
   promotion.ts — the compounding engine's spine (now a database table).

   Higher scopes (sector, company-lessons) are NOT authored directly. They are
   synthesised from what happens on projects, through a reviewed pipeline:

     a lesson emerges  →  NOMINATED  →  [human review queue]  →  PROMOTED
     (on a project)       (agent flags   (the "latent signals    (abstracted, to
                           it generalises) inbox" — you decide)   a broader scope)

   Gated by a human on purpose: auto-promoting everything would flood the company
   brain with noise and leak client specifics. Nominations live in the `promotions`
   table (were loose JSON files, one per nomination).
--------------------------------------------------------------------------- */

import { getDb, audit } from "./db";
import { ensureSeeded } from "./seed";
import { writeMemory } from "./memory";

export type Nomination = {
  id: string;
  fact: string;
  targetScope: string;
  reason: string;
  nominatedBy: string;
  sourceProject: string;
  sourceClient: string;
  status: "pending" | "promoted" | "rejected";
  created: string;
};

type Row = {
  id: string;
  fact: string | null;
  target_scope: string | null;
  reason: string | null;
  nominated_by: string | null;
  source_project: string | null;
  source_client: string | null;
  status: string;
  created: string | null;
};

function rowToNom(r: Row): Nomination {
  return {
    id: r.id,
    fact: r.fact ?? "",
    targetScope: r.target_scope ?? "",
    reason: r.reason ?? "",
    nominatedBy: r.nominated_by ?? "",
    sourceProject: r.source_project ?? "",
    sourceClient: r.source_client ?? "",
    status: (r.status as Nomination["status"]) ?? "pending",
    created: r.created ?? "",
  };
}

// Confidentiality leak-check (cheap substring pre-filter). Phase D adds an LLM
// classifier on top; this stays as the fast first pass.
export function leakCheck(text: string, terms: string[]): { flagged: boolean; hits: string[] } {
  const low = text.toLowerCase();
  const hits = terms.filter((t) => t && low.includes(t.toLowerCase()));
  return { flagged: hits.length > 0, hits };
}

export async function addNomination(input: {
  fact: string;
  targetScope: string;
  reason: string;
  nominatedBy: string;
  sourceProject: string;
  sourceClient: string;
}): Promise<Nomination> {
  await ensureSeeded();
  const id = `nom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const created = new Date().toISOString().slice(0, 10);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO promotions (id,fact,target_scope,reason,nominated_by,source_project,source_client,status,created)
       VALUES (?,?,?,?,?,?,?, 'pending', ?)`
    ).run(id, input.fact, input.targetScope, input.reason, input.nominatedBy, input.sourceProject, input.sourceClient, created);
    audit(db, { actor: input.nominatedBy, action: "nominate", scope: input.targetScope, detail: { fact: input.fact, reason: input.reason } });
  })();
  return { id, ...input, status: "pending", created };
}

export async function listNominations(status?: Nomination["status"]): Promise<Nomination[]> {
  await ensureSeeded();
  const rows = (status
    ? getDb().prepare("SELECT * FROM promotions WHERE status = ? ORDER BY created").all(status)
    : getDb().prepare("SELECT * FROM promotions ORDER BY created").all()) as Row[];
  return rows.map(rowToNom);
}

export async function getNomination(id: string): Promise<Nomination | null> {
  const r = getDb().prepare("SELECT * FROM promotions WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToNom(r) : null;
}

// Reject a nomination (keep it, marked rejected).
export async function rejectNomination(id: string, actor?: string): Promise<boolean> {
  const db = getDb();
  const info = db.transaction(() => {
    const r = db.prepare("UPDATE promotions SET status = 'rejected' WHERE id = ?").run(id);
    if (r.changes) audit(db, { actor, action: "reject-promotion", detail: { id } });
    return r.changes;
  })();
  return info > 0;
}

// Promote: write the (already-abstracted) text to the target scope as a learned
// memory, tag it with where it came from, and mark the nomination promoted.
export async function promoteNomination(
  id: string,
  finalText: string,
  actor?: string
): Promise<{ ok: boolean; scope?: string }> {
  const nom = await getNomination(id);
  if (!nom) return { ok: false };
  const [kind, name] = nom.targetScope.split("/");
  const appliesTo: Record<string, string> | undefined =
    kind === "sector" ? { sector: name } : kind === "client" ? { client: name } : undefined;
  await writeMemory({
    scope: nom.targetScope,
    type: "learned",
    body: finalText,
    importance: 0.5,
    appliesTo,
    provenance: {
      origin: "promoted",
      from_project: nom.sourceProject,
      nominated_by: nom.nominatedBy,
      approved_by: actor,
      promoted: new Date().toISOString().slice(0, 10),
    },
  });
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE promotions SET status = 'promoted' WHERE id = ?").run(id);
    audit(db, { actor, action: "promote", scope: nom.targetScope, detail: { id, text: finalText } });
  })();
  return { ok: true, scope: nom.targetScope };
}
