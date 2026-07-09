/* ---------------------------------------------------------------------------
   seed-history.ts — bulk "historical" backfill (ticket D1).

   The cold-start problem: the firm-level lenses (sales, marketing, signals) need
   knowledge DENSITY, which normally comes from many projects. But the asset needs
   CONTENT, not live pipeline — a firm has years of closed engagements. This script
   lays down a set of past-engagement fixtures across several clients and sectors so
   the cross-project features have real substrate to work on.

   The fixtures deliberately share recurring themes so the triangulation engine
   (Slice 6) has genuine cross-project patterns to surface:
     • healthcare: reimbursement / regulatory downside is routinely under-modelled
     • cross-sector: finance sponsors require a stress-tested downside before sign-off
     • cross-sector: convenience is a wedge, not a moat — margin is cost-to-serve

   Idempotent: writes project.json + files for each project (overwriting fixtures).
   Run: npm run seed:history   (then npm run index + npm run cards:build)
--------------------------------------------------------------------------- */
export {};

import { promises as fs } from "fs";
import path from "path";

type Fixture = {
  id: string;
  config: { name: string; client: string; sector: string; type: string; status: string; stakeholders?: string[]; team?: string[] };
  files: Record<string, string>;
};

const ROOT = path.join(process.cwd(), "workspace", "projects");

const FIXTURES: Fixture[] = [
  // ---- Healthcare (multiple clients → a real sector) -----------------------
  {
    id: "meridian-health",
    config: { team: ["callum", "bob"], name: "Value-based care diligence", client: "meridian", sector: "healthcare", type: "diligence", status: "complete" },
    files: {
      "brief.md": `# Engagement brief — Meridian Health\n\nCommercial diligence on a value-based-care (VBC) transition for a regional hospital network. Question for the investment committee: is the 3-year margin case credible?\n`,
      "findings/key-findings.md": `# Key findings — Meridian VBC diligence\n\n- The base case (+3% margin over 3 years) relies on patient-volume assumptions that are **not stress-tested**. Under a realistic volume shift the case swings to roughly −2%.\n- **Reimbursement threshold risk is the largest, least-modelled downside.** Payers are tightening the "clinically actioned" bar; a program that only pencils out at current reimbursement is fragile.\n- Care-coordination staffing (cost-to-serve) is the second-order risk; the model assumed best-case ratios.\n\n## Recommendation\nProceed only with a stress-tested downside case and a reimbursement-contraction sensitivity. Lead the IC memo with the downside, not the upside.\n`,
    },
  },
  {
    id: "summit-care",
    config: { team: ["bob"], name: "Chronic-care expansion strategy", client: "summit", sector: "healthcare", type: "strategy", status: "complete" },
    files: {
      "brief.md": `# Engagement brief — Summit Care\n\nGrowth strategy for a chronic-care management (CCM) provider weighing a remote-monitoring (RPM) expansion.\n`,
      "synthesis/recommendation.md": `# Recommendation — Summit Care RPM expansion\n\nExpand RPM, but pair it with CCM rather than selling monitoring alone — the pairing is where retention and unit economics actually work.\n\n**The binding constraint is operational, not technical:** staffing the monitoring, triaging alerts, and routing exceptions. The programs that win are the ones with the lowest, most predictable **cost-to-serve** — not the ones charging the most.\n\nWe stress-tested against reimbursement contraction and cost-to-serve overrun; the plan holds only if staffing discipline is treated as the core competency. Convenience pricing was explicitly **not** built into the margin case — it is a patient-acquisition wedge, not a durable moat.\n`,
    },
  },
  // ---- Financial services --------------------------------------------------
  {
    id: "northwind-bank",
    config: { team: ["bob"], name: "Digital lending expansion", client: "northwind", sector: "financial-services", type: "strategy", status: "complete" },
    files: {
      "brief.md": `# Engagement brief — Northwind Bank\n\nStrategy for expanding into digital consumer lending. Sponsor is the CFO; the credit committee must approve.\n`,
      "synthesis/recommendation.md": `# Recommendation — Northwind digital lending\n\nExpand in two phases, gated on a **stress-tested downside**: the CFO and credit committee will not approve a growth case that only works in benign conditions.\n\nThe binding constraint is **finance's risk appetite**, not product readiness — the same pattern we see with hospital-network finance sponsors. Lead the board case with the downside (loss-rate shock, funding-cost spike), then the upside. An upside-only case stalls.\n`,
    },
  },
  {
    id: "atlas-payments",
    config: { team: ["bob"], name: "Payments acquisition diligence", client: "atlas", sector: "financial-services", type: "diligence", status: "complete" },
    files: {
      "brief.md": `# Engagement brief — Atlas Payments\n\nBuy-side diligence on a payments processor. Is the target's take-rate durable?\n`,
      "findings/key-findings.md": `# Key findings — Atlas Payments diligence\n\n- The target's premium take-rate is a **convenience/onboarding wedge, not a moat** — it erodes when a lower-friction competitor appears. Do not build the deal case on it holding.\n- Durable margin sits in **cost-to-serve discipline** (fraud handling, support cost per merchant), which is under-invested.\n- Regulatory / interchange-cap risk is the largest downside and is thinly modelled.\n\n## Recommendation\nRe-underwrite with the convenience premium stripped out and a regulatory-downside sensitivity. Lead with the downside for the IC.\n`,
    },
  },
  // ---- Retail / consumer ---------------------------------------------------
  {
    id: "harbor-retail",
    config: { team: ["bob"], name: "Omnichannel growth strategy", client: "harbor", sector: "retail", type: "strategy", status: "complete" },
    files: {
      "brief.md": `# Engagement brief — Harbor Retail\n\nOmnichannel growth strategy for a mid-market retailer weighing a paid-convenience delivery tier.\n`,
      "synthesis/recommendation.md": `# Recommendation — Harbor omnichannel\n\nUse the convenience tier to **acquire**, not to defend margin. Willingness-to-pay for convenience is real but fragile — it erodes fast once a lower-friction rival appears. **Convenience is a wedge, not a moat.**\n\nDurable margin comes from **cost-to-serve discipline** (fulfilment cost per order), the same pattern we've seen in healthcare RPM and in payments. Build the margin case on cost-to-serve, and stress-test the convenience-premium erosion explicitly.\n`,
    },
  },
];

async function main() {
  for (const fx of FIXTURES) {
    const base = path.join(ROOT, fx.id);
    await fs.mkdir(path.join(base, "files"), { recursive: true });
    await fs.writeFile(path.join(base, "project.json"), JSON.stringify(fx.config, null, 2) + "\n", "utf8");
    for (const [rel, content] of Object.entries(fx.files)) {
      const target = path.join(base, "files", rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    console.log(`  seeded ${fx.id} (${fx.config.sector} · ${fx.config.client} · ${fx.config.status})`);
  }
  console.log(`\n✅ backfilled ${FIXTURES.length} historical engagements. Next: npm run index && npm run cards:build`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
