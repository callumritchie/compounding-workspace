/* ---------------------------------------------------------------------------
   stakeholders.ts — the PEOPLE registry (single source of truth).

   A stakeholder can appear on many projects (even for different clients), so we
   store each person ONCE here and let projects reference them by id. Rename a
   person here and every project + every stakeholder/<id> memory updates with no
   duplicate records to chase.

     workspace/stakeholders.json  →  { "<id>": { name, role, org? } }
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

export type StakeholderRecord = { name: string; role: string; org?: string };
export type Stakeholder = { id: string } & StakeholderRecord;

const FILE = path.join(process.cwd(), "workspace", "stakeholders.json");

async function readRegistry(): Promise<Record<string, StakeholderRecord>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, StakeholderRecord>;
  } catch {
    return {};
  }
}

async function writeRegistry(reg: Record<string, StakeholderRecord>): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

export async function listStakeholders(): Promise<Stakeholder[]> {
  const reg = await readRegistry();
  return Object.entries(reg).map(([id, r]) => ({ id, ...r }));
}

// Resolve a list of ids to full records, in order. Unknown ids degrade gracefully
// so a stale project reference never crashes — it just shows the raw id.
export async function resolveStakeholders(ids: string[]): Promise<Stakeholder[]> {
  const reg = await readRegistry();
  return ids.map((id) => (reg[id] ? { id, ...reg[id] } : { id, name: id, role: "?" }));
}

export async function getStakeholder(id: string): Promise<Stakeholder> {
  const reg = await readRegistry();
  return reg[id] ? { id, ...reg[id] } : { id, name: id, role: "?" };
}

// Patch one person; the change propagates everywhere they're referenced.
export async function updateStakeholder(id: string, patch: Partial<StakeholderRecord>): Promise<void> {
  const reg = await readRegistry();
  const base: StakeholderRecord = reg[id] ?? { name: id, role: "?" };
  reg[id] = { ...base, ...patch };
  await writeRegistry(reg);
}
