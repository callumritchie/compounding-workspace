/* ---------------------------------------------------------------------------
   demo.ts — reset the guided-demo baseline so scenarios are repeatable.

   The scenarios lean on a fresh "strong start" project (acme-expansion, seeded
   in the repo) and one pending nomination Bob can't promote alone. Running a
   scenario can consume that nomination (or leave a promoted company lesson);
   resetDemo() restores the baseline: re-create the pending nomination and clear
   any demo-promoted company lessons.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

const ROOT = process.cwd();
const NOM_FILE = path.join(ROOT, "workspace", "memory", "_promotion_queue", "nom_demo_company.json");
const COMPANY_LESSONS = path.join(ROOT, "workspace", "memory", "company", "lessons");

export const DEMO_NOMINATION = {
  id: "nom_demo_company",
  fact: "On the Acme diligence the CFO wouldn't sign off until the downside was independently modelled — this keeps recurring, so we should make 'lead with an independently-modelled downside' firm-wide guidance.",
  targetScope: "company/lessons",
  reason: "Observed across several healthcare engagements; generalises beyond one client.",
  nominatedBy: "bob",
  sourceProject: "acme-diligence",
  sourceClient: "acme",
  status: "pending" as const,
  created: "2026-07-01",
};

export async function resetDemo(): Promise<void> {
  await fs.mkdir(path.dirname(NOM_FILE), { recursive: true });
  await fs.writeFile(NOM_FILE, JSON.stringify(DEMO_NOMINATION, null, 2) + "\n", "utf8");
  // Baseline has no company lessons; drop anything a prior demo promoted.
  try {
    const files = await fs.readdir(COMPANY_LESSONS);
    await Promise.all(files.filter((f) => f.endsWith(".md")).map((f) => fs.unlink(path.join(COMPANY_LESSONS, f))));
  } catch {
    /* folder doesn't exist yet — nothing to clear */
  }
}
