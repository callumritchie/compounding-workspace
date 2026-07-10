/* ---------------------------------------------------------------------------
   eval-faithfulness.ts — the GROUNDING gate.

   The pass/fail golden set (eval.ts) checks the answer contains the right things.
   This deeper eval checks the answer isn't MAKING THINGS UP: for each grounded
   scenario it reconstructs the exact evidence the agent saw (from its tool trace)
   and has a separate judge model score how faithfully the answer is grounded in it
   — the RAGAS "faithfulness" metric, plus a citation check.

   Run it:  npm run eval:faith            (all grounded scenarios)
            npm run eval:faith --only rag (subset)

   Prints per-scenario faithfulness / citation-accuracy + any unsupported claims,
   an aggregate hallucination rate, and exits non-zero if grounding drops below the
   gate — so "our answers are evidenced" becomes a measured, enforceable claim.
--------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local — will fail clearly on the first API call */
}

type Scenario = {
  id: string;
  description: string;
  user: string;
  openFile?: string;
  message: string;
  expect: { readsFile?: string };
};

// Gate thresholds. An LLM judge over one scenario is a NOISY estimator (grading and
// the agent both vary run to run), so we gate on the MEAN across scenarios — a stable
// signal that catches a real grounding regression — plus a catastrophic per-scenario
// FLOOR for a blatant hallucination. The per-scenario numbers still print, as the
// diagnostic that tells you WHERE to look.
const MEAN_MIN = 0.8; // mean faithfulness across grounded scenarios
const PER_SCENARIO_FLOOR = 0.35; // a single answer this ungrounded is a hard fail

// Tools whose output IS the evidence the model was grounded on.
const EVIDENCE_TOOLS = new Set(["read_file", "search_files", "semantic_search", "list_files"]);

const allScenarios: Scenario[] = JSON.parse(readFileSync("workspace/evals/golden.json", "utf8"));

// Only scenarios where grounding-faithfulness is meaningful (corpus/engagement
// evidence, or the "don't fabricate when it's missing" case). Memory-only scenarios
// (e.g. applying a sector preference) aren't graded here.
function isGrounded(s: Scenario): boolean {
  return Boolean(s.expect.readsFile) || /rag|tension|find-fact|honest|constraint/.test(s.id);
}

const onlyIdx = process.argv.indexOf("--only");
const onlyTerm = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] ?? "").toLowerCase() : "";
const scenarios = allScenarios
  .filter(isGrounded)
  .filter((s) => (onlyTerm ? s.id.toLowerCase().includes(onlyTerm) : true));

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

async function run() {
  const { respond } = await import("../lib/agent");
  const { DEFAULT_PROJECT, readFile } = await import("../lib/corpus");
  const { buildWorkingContext } = await import("../lib/context");
  const { getMemoriesForContext } = await import("../lib/memory");
  const { assembleContext } = await import("../lib/assemble");
  const { getEngagement, engagementDigest } = await import("../lib/engagement");
  const { judgeAnswer } = await import("../lib/faithfulness");

  const engagement = await getEngagement(DEFAULT_PROJECT);
  const engagementBlock = engagement ? engagementDigest(engagement) : "";

  const faiths: number[] = [];
  const cites: number[] = [];
  let hallucinating = 0;
  const belowGate: string[] = [];

  for (const sc of scenarios) {
    const workingContext = buildWorkingContext({ projectId: DEFAULT_PROJECT, openFile: sc.openFile });
    const memories = await getMemoriesForContext(sc.user, DEFAULT_PROJECT);
    const assembled = assembleContext(memories, workingContext);
    const volatileBlock = [engagementBlock, assembled.volatileBlock].filter(Boolean).join("\n\n");

    const { text, trace } = await respond([{ role: "user", content: sc.message }], {
      projectId: DEFAULT_PROJECT,
      user: sc.user,
      stableBlock: assembled.stableBlock,
      volatileBlock,
    });

    // Reconstruct the FULL grounding the agent actually had — not just tool results,
    // but the same context the model saw: the open file, the injected memory +
    // engagement + working-context blocks, and every retrieval/read tool result. A
    // claim is only a hallucination if it's supported by NONE of this.
    const toolEvidence = trace
      .filter((t) => EVIDENCE_TOOLS.has(t.tool) && t.result)
      .map((t) => `## ${t.tool} — ${t.summary}\n${t.result}`);
    const openFileText = sc.openFile ? `## open file — ${sc.openFile}\n${await readFile(DEFAULT_PROJECT, sc.openFile).catch(() => "")}` : "";
    const contextText = `## injected context (memory · engagement · working context)\n${assembled.stableBlock}\n\n${volatileBlock}`;
    const evidence = [openFileText, contextText, ...toolEvidence].filter(Boolean).join("\n\n").slice(0, 22000);

    const v = await judgeAnswer({ question: sc.message, answer: text, evidence });
    faiths.push(v.faithfulness);
    cites.push(v.citationAccuracy);
    if (v.unsupported.length > 0) hallucinating++;

    if (v.faithfulness < PER_SCENARIO_FLOOR) belowGate.push(sc.id);
    // ✅ ≥0.8, ⚠️ 0.35–0.8 (worth a look, not a gate fail), ❌ below the floor.
    const mark = v.faithfulness >= 0.8 ? "✅" : v.faithfulness >= PER_SCENARIO_FLOOR ? "⚠️ " : "❌";
    console.log(`${mark} ${sc.id} — faithfulness ${pct(v.faithfulness)} · citations ${pct(v.citationAccuracy)}`);
    if (v.unsupported.length > 0) {
      for (const u of v.unsupported.slice(0, 4)) console.log(`     ↳ unsupported: ${u}`);
    }
  }

  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 1);
  const meanFaith = mean(faiths);
  const meanCite = mean(cites);
  const hallucinationRate = scenarios.length ? hallucinating / scenarios.length : 0;

  console.log(
    `\nGrounding across ${scenarios.length} scenarios — mean faithfulness ${pct(meanFaith)} · mean citation accuracy ${pct(
      meanCite
    )} · hallucination rate ${pct(hallucinationRate)}`
  );

  const pass = meanFaith >= MEAN_MIN && belowGate.length === 0;
  if (!pass) {
    const why = [
      meanFaith < MEAN_MIN ? `mean faithfulness ${pct(meanFaith)} < ${pct(MEAN_MIN)}` : "",
      belowGate.length ? `below floor ${pct(PER_SCENARIO_FLOOR)}: ${belowGate.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    console.log(`Faithfulness gate: FAIL (${why})`);
    process.exit(1);
  }
  console.log("Faithfulness gate: PASS");
}

run();
