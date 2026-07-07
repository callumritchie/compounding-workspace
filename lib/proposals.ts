/* ---------------------------------------------------------------------------
   proposals.ts — SUGGESTED memories awaiting the user's approval (DB table).

   The contrast with the promotion queue (lib/promotion.ts):
     • promotion  = take an EXISTING project memory and share it more broadly.
     • proposal   = a NEW memory the agent wants to save to a shared scope, held
                    here until a human approves it.

   Personal memories still save immediately (only the user sees them). Anything
   shared with the team goes through here first — consent before the shared brain
   changes. Moved off loose JSON files onto a transactional table.
--------------------------------------------------------------------------- */

import { getDb, audit } from "./db";
import { ensureSeeded } from "./seed";
import { writeMemory } from "./memory";

export type Proposal = {
  id: string;
  fact: string;
  scope: string;
  proposedBy: string;
  sourceProject: string;
  created: string;
};

type Row = { id: string; fact: string | null; scope: string | null; proposed_by: string | null; source_project: string | null; created: string | null };

function rowToProposal(r: Row): Proposal {
  return {
    id: r.id,
    fact: r.fact ?? "",
    scope: r.scope ?? "",
    proposedBy: r.proposed_by ?? "",
    sourceProject: r.source_project ?? "",
    created: r.created ?? "",
  };
}

export async function addProposal(input: {
  fact: string;
  scope: string;
  proposedBy: string;
  sourceProject: string;
}): Promise<Proposal> {
  await ensureSeeded();
  const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const created = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO proposals (id,fact,scope,proposed_by,source_project,created) VALUES (?,?,?,?,?,?)").run(
      id,
      input.fact,
      input.scope,
      input.proposedBy,
      input.sourceProject,
      created
    );
    audit(db, { actor: input.proposedBy, action: "propose", scope: input.scope, detail: { fact: input.fact } });
  })();
  return { id, ...input, created };
}

export async function listProposals(): Promise<Proposal[]> {
  await ensureSeeded();
  const rows = getDb().prepare("SELECT * FROM proposals ORDER BY created").all() as Row[];
  return rows.map(rowToProposal);
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const r = getDb().prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

// Approve → write the memory (born a touch above cold-start, since a human
// confirmed it), then remove the proposal.
export async function approveProposal(id: string, finalText?: string, actor?: string): Promise<boolean> {
  const p = await getProposal(id);
  if (!p) return false;
  await writeMemory({
    scope: p.scope,
    type: "learned",
    body: finalText ?? p.fact,
    importance: 0.3,
    provenance: {
      origin_user: p.proposedBy,
      origin_project: p.sourceProject,
      approved_by_user: actor ?? true,
      created: new Date().toISOString().slice(0, 10),
    },
  });
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM proposals WHERE id = ?").run(id);
    audit(db, { actor, action: "approve-proposal", scope: p.scope, detail: { fact: finalText ?? p.fact } });
  })();
  return true;
}

export async function dismissProposal(id: string, actor?: string): Promise<boolean> {
  const db = getDb();
  const changes = db.transaction(() => {
    const r = db.prepare("DELETE FROM proposals WHERE id = ?").run(id);
    if (r.changes) audit(db, { actor, action: "dismiss-proposal", detail: { id } });
    return r.changes;
  })();
  return changes > 0;
}
