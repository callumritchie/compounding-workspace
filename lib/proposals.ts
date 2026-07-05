/* ---------------------------------------------------------------------------
   proposals.ts — SUGGESTED memories awaiting the user's approval.

   The contrast with the promotion queue (lib/promotion.ts):
     • promotion  = take an EXISTING project memory and share it more broadly.
     • proposal   = a NEW memory the agent wants to save to the shared project
                    scope, held here until the user approves it.

   Personal memories still save immediately (only the user sees them). Anything
   that would be shared with the team goes through here first — consent before
   the shared brain changes. Files live in workspace/memory/_proposals/ (the
   leading "_" keeps them out of the memory library + scope reads).
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { writeMemory } from "./memory";

const DIR = path.join(process.cwd(), "workspace", "memory", "_proposals");

export type Proposal = {
  id: string;
  fact: string;
  scope: string; // where it would be saved, e.g. project/acme-health
  proposedBy: string;
  sourceProject: string;
  created: string;
};

async function ensure(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

export async function addProposal(input: {
  fact: string;
  scope: string;
  proposedBy: string;
  sourceProject: string;
}): Promise<Proposal> {
  await ensure();
  const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const p: Proposal = { id, created: new Date().toISOString(), ...input };
  await fs.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(p, null, 2), "utf8");
  return p;
}

export async function listProposals(): Promise<Proposal[]> {
  try {
    const names = await fs.readdir(DIR);
    const out: Proposal[] = [];
    for (const n of names) {
      if (n.endsWith(".json")) out.push(JSON.parse(await fs.readFile(path.join(DIR, n), "utf8")) as Proposal);
    }
    return out.sort((a, b) => a.created.localeCompare(b.created));
  } catch {
    return [];
  }
}

export async function getProposal(id: string): Promise<Proposal | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${path.basename(id)}.json`), "utf8")) as Proposal;
  } catch {
    return null;
  }
}

// Approve → actually write the memory (born a touch above cold-start, since a
// human confirmed it), then remove the proposal.
export async function approveProposal(id: string, finalText?: string): Promise<boolean> {
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
      approved_by_user: true,
      created: new Date().toISOString().slice(0, 10),
    },
  });
  await fs.unlink(path.join(DIR, `${path.basename(id)}.json`)).catch(() => {});
  return true;
}

export async function dismissProposal(id: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(DIR, `${path.basename(id)}.json`));
    return true;
  } catch {
    return false;
  }
}
