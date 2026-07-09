/* ---------------------------------------------------------------------------
   check-invariants.ts — the deterministic guard for the hardening work.

   Unlike eval.ts (which drives the real agent and needs an API key), this asserts
   the production-grade INVARIANTS hold — the properties the P1–P4 + governance
   fixes are supposed to guarantee. It's fully local: SQLite + the on-device
   embedder + pure functions. No API key, no model calls, so it can gate every
   commit cheaply and never flakes.

   Runs against a throwaway temp DB so it never touches the real workspace state.

   Run: npm run check:invariants   (part of npm run verify)
--------------------------------------------------------------------------- */

import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { _setDbForTest, getDb } from "../lib/db";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  // Point every store at a fresh temp DB before anything calls getDb().
  const dbFile = path.join(os.tmpdir(), `invariants-${Date.now()}.db`);
  _setDbForTest(dbFile);

  const {
    writeMemory,
    updateMemory,
    graduateOnUse,
    recordMemoryUse,
    listAllMemories,
    GRADUATION_THRESHOLD,
  } = await import("../lib/memory");
  const { decayMemories } = await import("../lib/lifecycle");
  const { assembleContext } = await import("../lib/assemble");
  const { leakCheck } = await import("../lib/promotion");
  const { canApprove } = await import("../lib/team");
  const { engagementDigest, engagementSummary } = await import("../lib/engagement");

  // ---- P1: no lost updates under concurrent writes -------------------------
  // The whole point of moving to a transactional store. Fire many writes at one
  // memory at once; the final count must be exact (the old JSON read-modify-write
  // could silently drop increments).
  const target = await writeMemory({ scope: "project/acme-health", body: "P1 concurrency target.", importance: 0.3 });
  const N = 50;
  await Promise.all(Array.from({ length: N }, () => recordMemoryUse([{ scope: target.scope, id: target.id }])));
  const after1 = (await listAllMemories()).find((m) => m.id === target.id);
  check("P1 no lost updates under concurrency", after1?.useCount === N, `use_count=${after1?.useCount}, expected ${N}`);

  // ---- P2a: usage is not correctness (graduation does NOT raise importance) --
  const prov = await writeMemory({ scope: "project/acme-health", body: "P2 provisional fact.", importance: 0.2, status: "provisional" });
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) await graduateOnUse([{ scope: prov.scope, id: prov.id }]);
  const grad = (await listAllMemories()).find((m) => m.id === prov.id);
  check("P2a graduation flips provisional→active", grad?.status === "active", `status=${grad?.status}`);
  check("P2a graduation does NOT raise importance", grad?.importance === 0.2, `importance=${grad?.importance} (was 0.2)`);

  // ---- P2b: decay lowers untouched learned memory; spares pinned ------------
  const stale = await writeMemory({ scope: "project/acme-health", body: "P2 stale learned note.", importance: 0.3 });
  const pinned = await writeMemory({ scope: "project/acme-health", body: "P2 pinned note.", importance: 0.3, pinned: true });
  getDb().prepare("UPDATE memories SET created='2026-01-01', last_used=NULL, last_reinforced=NULL WHERE id IN (?,?)").run(stale.id, pinned.id);
  await decayMemories();
  const all2 = await listAllMemories();
  const staleAfter = all2.find((m) => m.id === stale.id);
  const pinnedAfter = all2.find((m) => m.id === pinned.id);
  check("P2b decay lowers untouched learned importance", (staleAfter?.importance ?? 1) < 0.3, `importance=${staleAfter?.importance}`);
  check("P2b decay spares pinned memory", pinnedAfter?.importance === 0.3, `importance=${pinnedAfter?.importance}`);

  // ---- Poisoning defense (end-to-end): spamming usage can't promote a wrong ---
  // provisional fact into authority. Inject a wrong provisional memory, "use" it
  // far past the graduation threshold, and assert it (a) never gains importance
  // and (b) never rides the cached/authoritative tier. This is the anti-poisoning
  // property the "reinforce on correctness, not usage" rule is meant to hold —
  // guarded deterministically here (stronger + non-flaky vs. an LLM golden).
  const poison = await writeMemory({ scope: "project/acme-health", body: "POISON: the CFO signs off without any stress test.", importance: 0.2, status: "provisional" });
  for (let i = 0; i < GRADUATION_THRESHOLD * 5; i++) {
    await recordMemoryUse([{ scope: poison.scope, id: poison.id }]);
    await graduateOnUse([{ scope: poison.scope, id: poison.id }]);
  }
  const poisoned = (await listAllMemories()).find((m) => m.id === poison.id);
  const poisonAsm = assembleContext([poisoned!], "");
  const poisonTier = poisonAsm.report.injected.find((i) => i.id === poison.id)?.tier;
  check("Poisoning: heavy usage does NOT raise a wrong fact's importance", poisoned?.importance === 0.2, `importance=${poisoned?.importance}`);
  check("Poisoning: a used-but-unconfirmed fact never reaches the cached tier", poisonTier === "ranked", `tier=${poisonTier}`);

  // ---- P3: substring leak check flags a client term ------------------------
  check("P3 leak check flags a client name", leakCheck("Acme Health signed off fast.", ["Acme Health"]).flagged === true);
  check("P3 leak check passes a general lesson", leakCheck("Lead with the downside case for risk-averse sponsors.", ["Acme Health"]).flagged === false);

  // ---- P4: cache-stable tier = constitution|pinned, NOT importance ----------
  // A high-importance NON-pinned learned memory must NOT ride the cached prefix
  // (importance is mutable — gating the cache on it churns the cache).
  const hot = await writeMemory({ scope: "project/acme-health", body: "P4 hot learned note.", importance: 0.95 });
  const pin2 = await writeMemory({ scope: "project/acme-health", body: "P4 pinned note.", importance: 0.3, pinned: true });
  const mems = (await listAllMemories()).filter((m) => m.id === hot.id || m.id === pin2.id);
  const asm = assembleContext(mems, "");
  const hotItem = asm.report.injected.find((i) => i.id === hot.id);
  const pinItem = asm.report.injected.find((i) => i.id === pin2.id);
  check("P4 high-importance non-pinned learned is NOT in cached tier", hotItem?.tier === "ranked", `tier=${hotItem?.tier}`);
  check("P4 pinned learned IS in cached tier", pinItem?.tier === "stable", `tier=${pinItem?.tier}`);

  // ---- Engagement constraints: deterministic digest surfaces the pressures ---
  // The always-on constraints block is computed with no LLM, so it must reliably
  // show budget %, the at-risk milestone, and the top risk — that's what makes the
  // agent's advice land in reality.
  const eng = {
    sow: "Fixed-fee strategy engagement",
    budget: { total: 180000, spent: 121000, currency: "USD" },
    timeline: {
      phase: "Synthesis",
      end: "2030-01-01",
      milestones: [
        { name: "Discovery", due: "2020-01-01", status: "done" },
        { name: "Draft recommendation", due: "2030-01-01", status: "at-risk" },
      ],
    },
    scope: { in: ["strategy"], out: ["vendor selection"], changeRequests: [] },
    team: [{ name: "Bob", role: "Analyst", availability: "full-time" }],
    risks: [
      { text: "budget 67% spent, synthesis incomplete", severity: "medium" },
      { text: "synthesis behind the draft date", severity: "high" },
    ],
  };
  const digest = engagementDigest(eng);
  check("Engagement digest shows budget %", digest.includes("67% spent"), digest.split("\n").find((l) => l.includes("Budget")) ?? "");
  check("Engagement digest flags the at-risk milestone", /Draft recommendation.*AT RISK/.test(digest));
  check("Engagement digest does NOT flag a done milestone", !/Discovery.*AT RISK/.test(digest));
  check("Engagement digest surfaces the high-severity risk first", /Active risks: \[high\]/.test(digest));
  const sum = engagementSummary(eng);
  check("Engagement summary picks the at-risk next milestone", sum.nextMilestone?.name === "Draft recommendation" && sum.nextMilestone.atRisk === true, JSON.stringify(sum.nextMilestone));
  check("Engagement summary reports budget %", sum.budgetPct === 67, `budgetPct=${sum.budgetPct}`);

  // ---- Governance: analyst blocked on shared scopes, lead allowed ----------
  check("Gov analyst cannot approve company-level", canApprove("bob", "company/lessons") === false);
  check("Gov analyst cannot approve client-level", canApprove("bob", "client/acme") === false);
  check("Gov lead can approve company-level", canApprove("callum", "company/lessons") === true);
  check("Gov any member can confirm project-level", canApprove("bob", "project/acme-health") === true);

  // ---- Signal Engine: atom store, freshness, whitespace, gating -----------
  const { insertAtoms, queryAtoms } = await import("../lib/signals/atoms");
  const { buildInbox } = await import("../lib/signals/inbox");
  const { detectWhitespace } = await import("../lib/signals/whitespace");
  const { canSeeDeliveryHealth } = await import("../lib/team");

  const mkAtom = (o: Partial<Parameters<typeof insertAtoms>[0][number]>) => ({
    id: "x", type: "buying", text: "t", evidence: "e", source: "s", sourceKind: "client-transcript",
    project: "p", client: "c", sector: "healthcare", scope: "client/c", confidence: 0.8, urgency: 0.7,
    sentiment: null, ts: "", week: "", status: "new", ...o,
  });

  // Scope gating: an internal-transcript atom must NOT appear in a firm-tier read.
  await insertAtoms([
    mkAtom({ id: "atom-client", sourceKind: "client-transcript" }),
    mkAtom({ id: "atom-internal", sourceKind: "internal-transcript", type: "delivery-risk", scope: "project/p" }),
  ]);
  const firmTier = queryAtoms({ excludeInternal: true });
  check("Signal atom store round-trips", queryAtoms({}).some((a) => a.id === "atom-client"));
  check("Internal-transcript atoms are gated from firm-tier reads",
    firmTier.some((a) => a.id === "atom-client") && !firmTier.some((a) => a.id === "atom-internal"));

  // Delivery-health gating (derived from internal candour) — lead only.
  check("Delivery-health visible to the lead", canSeeDeliveryHealth("callum") === true);
  check("Delivery-health hidden from analyst & sales", canSeeDeliveryHealth("bob") === false && canSeeDeliveryHealth("dana") === false);

  // Whitespace diff: an unmet need FAR from the catalogue surfaces; one we already
  // sell is suppressed. (embedding-based coverage — deterministic, no API key.)
  // (identical text within each pair so the pair clusters — this test targets the
  // coverage DIFF, not the clustering, which is covered by the real-data eval.)
  const needUncovered = "They need implementation and change management support to execute strategy recommendations, not just strategy development.";
  const needCovered = "They asked for financial modelling and sensitivity analysis of the business case.";
  await insertAtoms([
    mkAtom({ id: "ws-a", type: "unmet-need", project: "wp-a", client: "wc-a", text: needUncovered }),
    mkAtom({ id: "ws-b", type: "unmet-need", project: "wp-b", client: "wc-b", text: needUncovered }),
    mkAtom({ id: "cov-a", type: "unmet-need", project: "cp-a", client: "cc-a", text: needCovered }),
    mkAtom({ id: "cov-b", type: "unmet-need", project: "cp-b", client: "cc-b", text: needCovered }),
  ]);
  const ws = await detectWhitespace();
  check("Whitespace surfaces an unmet need absent from the catalogue", ws.some((w) => /implementation|change|adopt|roll/i.test(w.need)));
  check("Whitespace suppresses demand we already sell", !ws.some((w) => /financial model|sensitivity/i.test(w.need)));

  // Freshness decay: two identical buying signals, the RECENT one must outrank the old.
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  await insertAtoms([
    mkAtom({ id: "fresh-new", type: "buying", project: "fp", client: "fc", text: "Adjacent need mentioned for next year.", ts: today, confidence: 0.8 }),
    mkAtom({ id: "fresh-old", type: "buying", project: "fp", client: "fc", text: "Adjacent need mentioned for next year.", ts: old, confidence: 0.8 }),
    mkAtom({ id: "soft-low", type: "competitive", project: "fp", client: "fc", text: "Possible competitor hint.", ts: today, confidence: 0.4 }),
  ]);
  const inbox = (await buildInbox("dana")).signals;
  const sNew = inbox.find((s) => s.id === "fresh-new");
  const sOld = inbox.find((s) => s.id === "fresh-old");
  check("Freshness decay ranks a recent signal above an identical old one", !!sNew && !!sOld && sNew.score > sOld.score, `new=${sNew?.score} old=${sOld?.score}`);

  // Confidence threshold: a low-confidence transcript signal is flagged soft (→ review).
  const softSig = inbox.find((s) => s.id === "soft-low");
  check("Low-confidence intel is flagged soft (routes to review)", softSig?.soft === true);
  check("High-confidence intel is not flagged soft", sNew?.soft === false);

  // cleanup temp DB
  try {
    await fs.rm(dbFile, { force: true });
    await fs.rm(`${dbFile}-wal`, { force: true });
    await fs.rm(`${dbFile}-shm`, { force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n${failures === 0 ? "✅ all invariants hold" : `❌ ${failures} invariant(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
