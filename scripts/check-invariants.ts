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
