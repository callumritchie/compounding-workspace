/* ---------------------------------------------------------------------------
   eval.ts — the "measure before mechanism" harness.

   It runs a fixed set of scored scenarios (workspace/evals/golden.json) through
   the real agent and checks two things per scenario:
     • retrieval  — did the agent read the file it should have?
     • answer     — does the answer contain (or avoid) the right things?

   Run it:  npm run eval        (all scenarios)
            npm run eval 2      (just the first 2, to save API cost)

   It prints a pass/fail table and exits non-zero if anything fails — so it can
   act as a regression gate before we ship any change to how context is chosen.
--------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";

// Scripts must load .env.local themselves (Next does this automatically for the
// app, but a plain Node script does not). Load it BEFORE importing the agent,
// so the Anthropic client sees the key when it is constructed.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local — will fail clearly on the first API call */
}

type Expect = {
  readsFile?: string;
  answerIncludesAll?: string[];
  answerIncludesAny?: string[];
};
type Scenario = {
  id: string;
  description: string;
  user: string;
  openFile?: string;
  message: string;
  expect: Expect;
};

const scenarios: Scenario[] = JSON.parse(readFileSync("workspace/evals/golden.json", "utf8"));
const limit = Number(process.argv[2]) || scenarios.length;

function checkAnswer(text: string, expect: Expect): string[] {
  const low = text.toLowerCase();
  const fails: string[] = [];
  for (const s of expect.answerIncludesAll ?? []) {
    if (!low.includes(s.toLowerCase())) fails.push(`missing "${s}"`);
  }
  if (expect.answerIncludesAny && expect.answerIncludesAny.length > 0) {
    const hit = expect.answerIncludesAny.some((s) => low.includes(s.toLowerCase()));
    if (!hit) fails.push(`none of [${expect.answerIncludesAny.join(", ")}]`);
  }
  return fails;
}

async function run() {
  // Import the agent AFTER env is loaded (its Anthropic client reads the key
  // at construction). Dynamic import keeps that ordering guaranteed.
  const { respond } = await import("../lib/agent");
  const { DEFAULT_PROJECT } = await import("../lib/corpus");
  const { buildWorkingContext } = await import("../lib/context");
  const { getMemoriesForContext } = await import("../lib/memory");
  const { assembleContext } = await import("../lib/assemble");

  let passed = 0;
  const failedIds: string[] = [];

  for (const sc of scenarios.slice(0, limit)) {
    const workingContext = buildWorkingContext({ projectId: DEFAULT_PROJECT, openFile: sc.openFile });
    const memories = await getMemoriesForContext(sc.user, DEFAULT_PROJECT);
    const assembled = await assembleContext(memories, workingContext, sc.message);
    const { text, trace } = await respond([{ role: "user", content: sc.message }], {
      projectId: DEFAULT_PROJECT,
      user: sc.user,
      stableBlock: assembled.stableBlock,
      volatileBlock: assembled.volatileBlock,
    });

    const fails: string[] = [];
    if (sc.expect.readsFile) {
      const read = trace.some((t) => t.tool === "read_file" && (t.input as { path?: string }).path === sc.expect.readsFile);
      if (!read) fails.push(`did not read ${sc.expect.readsFile}`);
    }
    fails.push(...checkAnswer(text, sc.expect));

    if (fails.length === 0) {
      passed++;
      console.log(`✅ ${sc.id} — ${sc.description}`);
    } else {
      failedIds.push(sc.id);
      console.log(`❌ ${sc.id} — ${sc.description}`);
      for (const f of fails) console.log(`     ↳ ${f}`);
      console.log(`     answer: ${text.slice(0, 140).replace(/\n/g, " ")}…`);
    }
  }

  const total = Math.min(limit, scenarios.length);
  console.log(`\n${passed}/${total} passed.`);
  if (failedIds.length > 0) {
    console.log(`Regression gate: FAIL (${failedIds.join(", ")})`);
    process.exit(1);
  }
  console.log("Regression gate: PASS");
}

run();
