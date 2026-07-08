/* ---------------------------------------------------------------------------
   seed-interactions.ts — backfill the raw material the Signal Engine feeds on:
   dated client + internal-team meeting transcripts, and weekly risk registers.

   As with the historical backfill, the point is CONTENT not pipeline: a firm has
   years of recorded interactions. The fixtures deliberately plant cross-project
   patterns so every signal family has real substrate:

     • UNMET NEED (→ new service line): clients across sectors keep asking for
       implementation / change-management / adoption support — which is explicitly
       out of our service catalogue.
     • RISK + MITIGATION (→ playbook): "client data-access delays" recurs; the
       "named data owner + weekly data-office standup" mitigation RESOLVES it, while
       "escalate to sponsor" STALLS — an evidence-based effectiveness pattern.
     • EARLY WARNING: a live engagement (acme-health) carries an escalating,
       unmitigated scope-misalignment risk.
     • BUYING / COMPETITIVE (→ sales): adjacent needs mentioned in client calls,
       a competitor named.
     • DECLINING SENTIMENT (→ churn): acme-expansion sentiment slides week on week.
     • DELIVERY HEALTH (internal, gated): the acme-health team voices concern.

   Run: npm run seed:interactions   (then npm run index && npm run signals:build)
--------------------------------------------------------------------------- */
export {};

import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "workspace", "projects");

type Transcript = { file: string; date: string; kind: "client" | "internal"; attendees: string; body: string };
type Fixture = { id: string; transcripts?: Transcript[]; riskRegister?: string };

function transcript(t: Transcript): string {
  return `---\ndate: ${t.date}\nkind: ${t.kind}\nattendees: ${JSON.stringify(t.attendees)}\n---\n\n${t.body.trim()}\n`;
}

const FIXTURES: Fixture[] = [
  // ===== acme-health (ACTIVE, healthcare) — the live engagement ==============
  {
    id: "acme-health",
    transcripts: [
      {
        file: "transcripts/2026-07-07-client-steerco.md",
        date: "2026-07-07",
        kind: "client",
        attendees: "Acme CFO, Acme COO; Callum, Bob",
        body: `**CFO:** The strategy work is landing well. Honestly the bigger question on my mind is what happens *after* the recommendation — once you hand us the plan, who actually helps us roll it out? We don't have the internal muscle to execute a change of this size.
**COO:** That's the real gap for us. Every strategy deck we've ever commissioned dies in the adoption phase.
**Callum:** Understood — let's note that.
**CFO:** One more thing looking ahead: next fiscal year we're going to need serious help on our payer-contracting approach too. Different problem, but it's coming and there'll be budget for it.
**COO:** And candidly, we need to get aligned internally on how far this current scope actually goes — my team and the CFO's team don't see the boundary the same way.`,
      },
      {
        file: "transcripts/2026-07-06-internal-team.md",
        date: "2026-07-06",
        kind: "internal",
        attendees: "Callum, Bob (internal only)",
        body: `**Bob:** I'm a bit worried about acme-health. The CFO and COO keep describing the scope differently and nobody's reconciled it. It's going to bite us at the draft readout.
**Callum:** Agreed, it's the top risk. We haven't landed a mitigation yet — I keep raising it and it slips.
**Bob:** Also I'm stretched thin; if this reopens scope I don't think we hit the milestone. Team morale is fine but the ambiguity is stressful.`,
      },
    ],
    riskRegister: `# Risk register — Acme Health (live)

| Week | Risk | Severity | Mitigation | Status |
|------|------|----------|------------|--------|
| 2026-W24 | Stakeholder misalignment on scope (CFO vs COO) | medium | Flag at steerco | open |
| 2026-W25 | Stakeholder misalignment on scope (CFO vs COO) | medium | Flag at steerco | open |
| 2026-W26 | Stakeholder misalignment on scope (CFO vs COO) | high | Pending — no owner agreed | open |
| 2026-W27 | Stakeholder misalignment on scope (CFO vs COO) | high | Pending — no owner agreed | open |
`,
  },

  // ===== acme-expansion (ACTIVE, healthcare) — the churn case ================
  {
    id: "acme-expansion",
    transcripts: [
      {
        file: "transcripts/2026-06-16-client-checkin.md",
        date: "2026-06-16",
        kind: "client",
        attendees: "Acme VP Strategy; Callum",
        body: `**VP:** Good session — the team's engaged and we're excited about where this is heading. Really positive momentum.`,
      },
      {
        file: "transcripts/2026-06-30-client-checkin.md",
        date: "2026-06-30",
        kind: "client",
        attendees: "Acme VP Strategy; Callum",
        body: `**VP:** It was fine. A couple of the numbers didn't quite match what we expected. Not a big deal but let's tighten it up.`,
      },
      {
        file: "transcripts/2026-07-07-client-checkin.md",
        date: "2026-07-07",
        kind: "client",
        attendees: "Acme VP Strategy; Callum",
        body: `**VP:** I'll be honest, the last readout missed the mark for us. I'm not sure we're seeing the value we expected from this workstream, and my sponsor is asking hard questions about whether to continue. We need this to turn around.`,
      },
    ],
    riskRegister: `# Risk register — Acme Expansion (live)

| Week | Risk | Severity | Mitigation | Status |
|------|------|----------|------------|--------|
| 2026-W24 | Sponsor perceives limited value | low | Regular check-ins | open |
| 2026-W26 | Sponsor perceives limited value | medium | Regular check-ins | open |
| 2026-W27 | Sponsor perceives limited value | high | Escalation pending | open |
`,
  },

  // ===== acme-diligence (complete, healthcare) — data-access STALLED =========
  {
    id: "acme-diligence",
    riskRegister: `# Risk register — Acme Diligence

| Week | Risk | Severity | Mitigation | Status |
|------|------|----------|------------|--------|
| 2026-W10 | Client data-access delays holding up analysis | high | Escalate to sponsor | open |
| 2026-W12 | Client data-access delays holding up analysis | high | Escalate to sponsor | open |
| 2026-W14 | Client data-access delays holding up analysis | high | Escalate to sponsor | stalled |
`,
  },

  // ===== beacon-health (complete, healthcare) — competitive + unmet need =====
  {
    id: "beacon-health",
    transcripts: [
      {
        file: "transcripts/2026-05-20-client-review.md",
        date: "2026-05-20",
        kind: "client",
        attendees: "Beacon CEO; Callum",
        body: `**CEO:** We like the direction. Full transparency, we're also talking to Meridian Advisory Partners about this, so the recommendation needs to be sharp.
**CEO:** And the thing we always struggle with afterwards is adoption — we'd value a partner who can help us actually implement, not just advise.`,
      },
    ],
  },

  // ===== meridian-health (complete, healthcare) — data-access RESOLVED =======
  {
    id: "meridian-health",
    riskRegister: `# Risk register — Meridian Health

| Week | Risk | Severity | Mitigation | Status |
|------|------|----------|------------|--------|
| 2026-W03 | Client data-access delays holding up analysis | high | Secure a named data owner + weekly data-office standup | open |
| 2026-W05 | Client data-access delays holding up analysis | medium | Named data owner in place; standup running | mitigated |
| 2026-W07 | Client data-access delays holding up analysis | low | Named data owner + standup | resolved |
`,
  },

  // ===== summit-care (complete, healthcare) — unmet need =====================
  {
    id: "summit-care",
    transcripts: [
      {
        file: "transcripts/2026-04-14-client-workshop.md",
        date: "2026-04-14",
        kind: "client",
        attendees: "Summit COO; Bob",
        body: `**COO:** The plan makes sense. What we never have is the change-management support to make it stick — our people revert to old habits within a quarter. If you offered that, we'd buy it.`,
      },
    ],
  },

  // ===== northwind-bank (complete, fin-svcs) — unmet need + buying ==========
  {
    id: "northwind-bank",
    transcripts: [
      {
        file: "transcripts/2026-05-05-client-readout.md",
        date: "2026-05-05",
        kind: "client",
        attendees: "Northwind CFO; Bob",
        body: `**CFO:** Strong analysis. My worry is execution — we simply don't have the internal change muscle to deliver this, and that's where these programmes usually fail.
**CFO:** Separately, the board has budget earmarked for a broader digital-transformation push next year. We'll need a partner for it.`,
      },
    ],
  },

  // ===== atlas-payments (complete, fin-svcs) — data-access RESOLVED =========
  {
    id: "atlas-payments",
    riskRegister: `# Risk register — Atlas Payments

| Week | Risk | Severity | Mitigation | Status |
|------|------|----------|------------|--------|
| 2026-W02 | Client data-access delays holding up analysis | high | Secure a named data owner + weekly data-office standup | open |
| 2026-W04 | Client data-access delays holding up analysis | low | Named data owner + standup working well | resolved |
`,
  },

  // ===== harbor-retail (complete, retail) — unmet need ======================
  {
    id: "harbor-retail",
    transcripts: [
      {
        file: "transcripts/2026-03-18-client-review.md",
        date: "2026-03-18",
        kind: "client",
        attendees: "Harbor CEO; Bob",
        body: `**CEO:** The strategy is great — but adoption is where we always fail. We'd pay for someone to embed and help us execute the change, not just hand us a deck.`,
      },
    ],
  },
];

async function main() {
  let files = 0;
  for (const fx of FIXTURES) {
    const base = path.join(ROOT, fx.id, "files");
    for (const t of fx.transcripts ?? []) {
      const target = path.join(base, t.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, transcript(t), "utf8");
      files++;
    }
    if (fx.riskRegister) {
      await fs.mkdir(base, { recursive: true });
      await fs.writeFile(path.join(base, "risk-register.md"), fx.riskRegister, "utf8");
      files++;
    }
    console.log(`  seeded ${fx.id}: ${(fx.transcripts ?? []).length} transcript(s)${fx.riskRegister ? " + risk register" : ""}`);
  }
  console.log(`\n✅ seeded ${files} interaction files across ${FIXTURES.length} engagements. Next: npm run index && npm run signals:build`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
