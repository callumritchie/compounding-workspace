/* ---------------------------------------------------------------------------
   promotion.ts — the compounding engine's spine.

   Higher scopes (sector, company-lessons) are NOT authored directly. They are
   synthesised from what happens on projects, through a reviewed pipeline:

     a lesson emerges  →  NOMINATED  →  [human review queue]  →  PROMOTED
     (on a project)       (agent flags   (the "latent signals    (abstracted, to
                           it generalises) inbox" — you decide)   a broader scope)

   This is deliberately gated by a human: auto-promoting everything would flood
   the company brain with noise and leak client specifics. The review queue is
   also the product's "latent signals" feature — the inbox that informs how the
   consultancy scopes and pitches work.

   Nominations live as JSON under workspace/memory/_promotion_queue/.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { writeMemory } from "./memory";

const QUEUE_DIR = path.join(process.cwd(), "workspace", "memory", "_promotion_queue");

export type Nomination = {
  id: string;
  fact: string; // the lesson as observed (may be project-specific)
  targetScope: string; // where it would be promoted, e.g. "sector/healthcare"
  reason: string; // why it generalises beyond this project
  nominatedBy: string; // user id or "agent"
  sourceProject: string;
  sourceClient: string; // used by the confidentiality leak-check at promotion
  status: "pending" | "promoted" | "rejected";
  created: string;
};

async function ensureDir() {
  await fs.mkdir(QUEUE_DIR, { recursive: true });
}

// Confidentiality leak-check: flag if any client-identifying term survives into
// the text about to be promoted to a shared scope. Cheap but effective guard.
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
  await ensureDir();
  const nom: Nomination = {
    id: `nom_${Date.now().toString(36)}`,
    fact: input.fact,
    targetScope: input.targetScope,
    reason: input.reason,
    nominatedBy: input.nominatedBy,
    sourceProject: input.sourceProject,
    sourceClient: input.sourceClient,
    status: "pending",
    created: new Date().toISOString().slice(0, 10),
  };
  await fs.writeFile(path.join(QUEUE_DIR, `${nom.id}.json`), JSON.stringify(nom, null, 2), "utf8");
  return nom;
}

export async function listNominations(status?: Nomination["status"]): Promise<Nomination[]> {
  let names: string[];
  try {
    names = await fs.readdir(QUEUE_DIR);
  } catch {
    return [];
  }
  const out: Nomination[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const nom = JSON.parse(await fs.readFile(path.join(QUEUE_DIR, name), "utf8")) as Nomination;
    if (!status || nom.status === status) out.push(nom);
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

export async function getNomination(id: string): Promise<Nomination | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(QUEUE_DIR, `${id}.json`), "utf8")) as Nomination;
  } catch {
    return null;
  }
}

async function saveNomination(nom: Nomination): Promise<void> {
  await fs.writeFile(path.join(QUEUE_DIR, `${nom.id}.json`), JSON.stringify(nom, null, 2), "utf8");
}

// Reject a nomination (keep it in the record, marked rejected).
export async function rejectNomination(id: string): Promise<boolean> {
  const nom = await getNomination(id);
  if (!nom) return false;
  nom.status = "rejected";
  await saveNomination(nom);
  return true;
}

// Promote: write the (already-abstracted) text to the target scope as a learned
// memory, tagged with where it came from, and mark the nomination promoted.
export async function promoteNomination(
  id: string,
  finalText: string
): Promise<{ ok: boolean; scope?: string }> {
  const nom = await getNomination(id);
  if (!nom) return { ok: false };
  // Tag the promoted memory so it only applies within its scope (e.g. a
  // sector/healthcare memory carries applies_to {sector: healthcare}).
  const [kind, name] = nom.targetScope.split("/");
  const appliesTo: Record<string, string> | undefined =
    kind === "sector" ? { sector: name } : kind === "client" ? { client: name } : undefined;
  await writeMemory({
    scope: nom.targetScope,
    type: "learned",
    body: finalText,
    importance: 0.5, // promoted lessons start meaningful but still earn trust
    appliesTo,
    provenance: {
      origin: "promoted",
      from_project: nom.sourceProject,
      nominated_by: nom.nominatedBy,
      promoted: new Date().toISOString().slice(0, 10),
    },
  });
  nom.status = "promoted";
  await saveNomination(nom);
  return { ok: true, scope: nom.targetScope };
}
