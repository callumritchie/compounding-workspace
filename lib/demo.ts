/* ---------------------------------------------------------------------------
   demo.ts — reset the guided-demo baseline so scenarios are repeatable.

   The scenarios lean on a fresh "strong start" project (acme-expansion) and one
   pending nomination Bob can't promote alone. Running a scenario can consume that
   nomination (or leave a promoted company lesson); resetDemo() restores the
   baseline by reseeding the database from the git-tracked markdown seeds (which
   include the demo nomination) — wiping any runtime memory back to the fixture.
--------------------------------------------------------------------------- */

import { reseed } from "./seed";

// Kept for callers that reference the fixture (also lives as the markdown seed
// workspace/memory/_promotion_queue/nom_demo_company.json that reseed imports).
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
  await reseed();
}
