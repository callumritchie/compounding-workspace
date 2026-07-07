/* Drive the agent to nominate a lesson for promotion (no chat history touched).
   Run: env -u ANTHROPIC_API_KEY npx tsx scripts/check-promotion.ts */
export {}; // treat this file as a module (isolates its local `main`)

try {
  process.loadEnvFile(".env.local");
} catch {}

async function main() {
  const { respond } = await import("../lib/agent");
  const { getMemoriesForContext } = await import("../lib/memory");
  const { assembleContext } = await import("../lib/assemble");
  const { buildWorkingContext } = await import("../lib/context");

  const project = "acme-health";
  const user = "callum";
  const message =
    "We've learned on this engagement that the CFO — the economic buyer — will not approve any recommendation " +
    "without a downside/sensitivity case, and this reflects how healthcare finance sponsors decide in general. " +
    "Please nominate this lesson for promotion to the sector so future healthcare projects start stronger.";

  const wc = buildWorkingContext({ projectId: project, openFile: null });
  const mems = await getMemoriesForContext(user, project);
  const asm = await assembleContext(mems, wc, message);
  const { text, trace } = await respond([{ role: "user", content: message }], {
    projectId: project,
    user,
    stableBlock: asm.stableBlock,
    volatileBlock: asm.volatileBlock,
  });

  console.log("TRACE:");
  trace.forEach((t) => console.log("  " + t.tool + " — " + t.summary));
  console.log("\nREPLY:", text.slice(0, 200));
}

main();
