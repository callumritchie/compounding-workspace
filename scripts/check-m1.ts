/* M1 proof: a lesson on Callum's project compounds to Bob's DIFFERENT project.
   Run: env -u ANTHROPIC_API_KEY npx tsx scripts/check-m1.ts */
export {}; // treat this file as a module (isolates its local `main`)

try {
  process.loadEnvFile(".env.local");
} catch {}

async function main() {
  const { respond, abstractLesson } = await import("../lib/agent");
  const { getMemoriesForContext } = await import("../lib/memory");
  const { assembleContext } = await import("../lib/assemble");
  const { buildWorkingContext } = await import("../lib/context");
  const { listNominations, promoteNomination, leakCheck } = await import("../lib/promotion");

  // 1. Callum, on acme-health, nominates a lesson to the sector.
  const project = "acme-health";
  const user = "callum";
  const msg =
    "We've learned the CFO (economic buyer) won't approve any recommendation without a downside/sensitivity " +
    "case — true of healthcare finance sponsors generally. Nominate this lesson for promotion to the sector.";
  const wc = buildWorkingContext({ projectId: project, openFile: null });
  const asm = await assembleContext(await getMemoriesForContext(user, project), wc, msg);
  const { trace } = await respond([{ role: "user", content: msg }], {
    projectId: project,
    user,
    stableBlock: asm.stableBlock,
    volatileBlock: asm.volatileBlock,
  });
  console.log("1. nominate:", trace.map((t) => t.summary).join(", ") || "(no tool used)");

  const pending = await listNominations("pending");
  const nom = pending[pending.length - 1];
  if (!nom) return console.log("❌ no nomination created");
  console.log("2. nomination →", nom.targetScope);

  // 3. Abstract + confidentiality leak-check.
  const abstracted = await abstractLesson(nom.fact, nom.sourceClient, "healthcare");
  const leak = leakCheck(abstracted, [nom.sourceClient, nom.sourceProject]);
  console.log("3. abstracted:", abstracted);
  console.log("   leak flagged:", leak.flagged, leak.hits);

  // 4. Promote.
  const r = await promoteNomination(nom.id, abstracted);
  console.log("4. promoted →", r.scope);

  // 5. Does Bob, on a DIFFERENT healthcare project, now see it?
  const bobMems = await getMemoriesForContext("bob", "beacon-health");
  const found = bobMems.some((m) => m.body === abstracted);
  console.log(`\n5. Bob @ beacon-health now sees ${bobMems.length} memories:`);
  bobMems.forEach((m) => console.log("   [" + m.scope + "] " + m.body.slice(0, 58)));
  console.log(found ? "\n✅ M1 PROVEN: Callum's lesson reached Bob on a different project." : "\n❌ M1: promoted lesson not found for Bob.");
}

main();
