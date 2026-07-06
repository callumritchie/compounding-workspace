/* ---------------------------------------------------------------------------
   agent.ts — the AI teammate, now with tools.

   This is the agentic loop, written by hand so you can SEE how it works:

     call the model  ─▶  did it ask to use a tool?
        ▲                     │ yes                    │ no
        │                     ▼                        ▼
        └──── append the tool's result           return the final answer
                                                  (+ a trace of what it did)

   The model decides for itself which files to open — that's "agentic
   navigation". We just run the tools it asks for and hand back the results.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Message } from "./workspace";
import { TOOLS, executeTool, type TraceEntry } from "./tools";
import { getMemoriesForContext } from "./memory";
import { readFile } from "./corpus";
import { getProjectConfig } from "./project";

// The reasoning engine. `claude-opus-4-8` is Anthropic's most capable Opus model.
const MODEL = "claude-opus-4-8";

// Stable persona + how to use the tools. Kept stable so it can be cached later.
// Exported so the chat route can estimate its token weight for the composition bar.
export const SYSTEM_BASE = `You are an AI teammate inside a consulting team's shared workspace.
You help consultants think through client projects using the project's files:
interviews, notes, hypotheses, and research.

You have tools to navigate the SHARED corpus: list_files, read_file, search_files
(exact keywords), semantic_search (by meaning), and write_file. Ground your answers
in the real files — prefer reading them over guessing. If the user refers to "this", "that file", or "the doc", resolve it from
the WORKING CONTEXT block (their currently open file). Only use write_file when the
user asks you to create or save something.

You also have long-term MEMORY. Facts you already know appear in the MEMORY section
of this prompt — respect them and weigh each by its trust label. When the user tells
you a durable preference, client fact, or lesson worth keeping, use save_memory so
you remember it next time. Be concise, direct, and practical.`;

// The SDK reads ANTHROPIC_API_KEY from the environment (including .env.local).
const client = new Anthropic();

// Streaming events emitted as the agent works (for the live view).
export type AgentEvent =
  | { type: "step"; n: number }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown>; summary: string };

// What the agent returns: the final answer, a trace of the tools it used, token
// usage (summed across every model call in the turn), and the reasoning summary.
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type AgentResult = { text: string; trace: TraceEntry[]; usage: Usage; reasoning: string };

// The agent loop. Streams as it goes: pass `onEvent` to receive thinking / tool /
// text events live; omit it to just run to completion (used by the eval + compare).
export type AgentSpec = { systemPrompt: string; model: string; toolNames?: string[] };

export async function runAgent(
  messages: Message[],
  opts: {
    projectId: string;
    user: string;
    stableBlock?: string;
    volatileBlock?: string;
    agent?: AgentSpec; // which agent (persona/model/tools); omitted → the default
  },
  onEvent?: (ev: AgentEvent) => void
): Promise<AgentResult> {
  // Resolve the agent harness: its system prompt, model, and the subset of tools
  // it may call. Omitting `agent` (eval + compare) keeps the shipped defaults.
  const persona = opts.agent?.systemPrompt ?? SYSTEM_BASE;
  const model = opts.agent?.model || MODEL;
  const tools =
    opts.agent?.toolNames && opts.agent.toolNames.length
      ? TOOLS.filter((t) => opts.agent!.toolNames!.includes(t.name))
      : TOOLS;

  // Order the prompt stable → volatile. The stable block (persona + constitution
  // + high-importance memory) sits behind a cache breakpoint; the volatile block
  // (ranked memory + working context) comes after and is never cached.
  const stableSystem = opts.stableBlock ? `${persona}\n\n${opts.stableBlock}` : persona;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
  ];
  if (opts.volatileBlock) system.push({ type: "text", text: opts.volatileBlock });

  // The running conversation. We start from history and append the model's
  // tool-use turns and our tool-result turns as the loop runs.
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: TraceEntry[] = [];
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let reasoning = "";

  // Safety cap: never loop more than this many model calls in one turn.
  for (let step = 0; step < 8; step++) {
    onEvent?.({ type: "step", n: step });
    let response: Anthropic.Message;
    try {
      // Stream the model call so we can surface thinking + answer text live.
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive" }, // let the model think as much as the task needs
        system,
        tools,
        messages: convo,
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "thinking_delta") {
            onEvent?.({ type: "thinking", text: event.delta.thinking }); // live view
          } else if (event.delta.type === "text_delta") {
            onEvent?.({ type: "text", text: event.delta.text });
          }
        }
      }
      response = await stream.finalMessage();
      // Capture reasoning from the authoritative final message (thinking blocks),
      // so the X-ray has it even when thinking isn't streamed as deltas.
      for (const b of response.content) {
        if (b.type === "thinking") reasoning += b.thinking;
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error(
          "Claude rejected the API key. Add a valid Anthropic API key to .env.local " +
            "(ANTHROPIC_API_KEY=sk-ant-...). Get one at console.anthropic.com."
        );
      }
      throw err;
    }

    // Tally token usage (and caching) for this call.
    usage.input += response.usage.input_tokens ?? 0;
    usage.output += response.usage.output_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // No tool requested → the model is done. Return its text.
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text: text || "(no response)", trace, usage, reasoning };
    }

    // Append the model's turn EXACTLY as received (keeps thinking + tool_use
    // blocks intact — the API requires this when tools are used).
    convo.push({ role: "assistant", content: response.content });

    // Intermediate text (the model narrating its plan before calling a tool) is
    // useful "reasoning" for the X-ray, even when thinking text isn't exposed.
    const narration = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (narration) reasoning += (reasoning ? "\n\n" : "") + narration;

    // Run every tool the model asked for and collect the results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const { result, summary } = await executeTool(
        { projectId: opts.projectId, user: opts.user },
        tu.name,
        input
      );
      trace.push({ tool: tu.name, input, summary, result: result.slice(0, 300) });
      onEvent?.({ type: "tool", name: tu.name, input, summary });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { text: "(stopped after too many tool steps)", trace, usage, reasoning };
}

// Non-streaming wrapper — used by the eval harness and /api/compare.
export async function respond(
  messages: Message[],
  opts: { projectId: string; user: string; stableBlock?: string; volatileBlock?: string; agent?: AgentSpec }
): Promise<AgentResult> {
  return runAgent(messages, opts);
}

// Abstraction step used at promotion time: turn a project-specific lesson into a
// general, reusable one — stripping client names and identifying specifics.
export async function abstractLesson(fact: string, clientName: string, scopeLabel: string): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system:
      `You abstract a project-specific lesson into a general, reusable one for a "${scopeLabel}" shared memory. ` +
      `Remove client names and any identifying specifics; keep only the transferable insight. ` +
      `Return ONLY the abstracted lesson, one or two sentences, no preamble.`,
    messages: [
      { role: "user", content: `Client: ${clientName}\nScope: ${scopeLabel}\nLesson: ${fact}\n\nAbstracted lesson:` },
    ],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Answer a question using ONLY the supplied passages (used by the retrieval
// comparison, so naïve-vector and reranked-vector answer purely from what they
// retrieved — no tools, no memory).
export async function answerFromContext(query: string, context: string): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system:
      "Answer the question using ONLY the provided context passages. If they don't contain the answer, say so plainly. Be concise.",
    messages: [{ role: "user", content: `Context passages:\n${context}\n\nQuestion: ${query}` }],
  });
  return textOf(response) || "(no answer)";
}

/* ---------------------------------------------------------------------------
   Cold-start helpers — one-shot Claude calls (no agent loop) that make a fresh
   project feel warm: a "what we already know" brief, click-to-send starter
   questions, and short intake questions whose answers seed provisional memory.
--------------------------------------------------------------------------- */

// Pull the first JSON object out of a model response, tolerating prose/fences.
function parseJsonObject<T>(text: string, fallback: T): T {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? (JSON.parse(match[0]) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Render the inherited, in-scope memory for a project as a plain bullet list the
// helper prompts can ground on. Personal prefs are excluded — a kickoff brief is
// about what the TEAM knows about the engagement, not one user's preferences.
async function inheritedMemoryLines(projectId: string, user: string): Promise<string> {
  const mems = await getMemoriesForContext(user, projectId);
  return mems
    .filter((m) => !m.scope.startsWith("personal/"))
    .map((m) => `- [${m.scope}] ${m.body}`)
    .join("\n");
}

export type Kickoff = { brief: string; questions: string[] };

// Where a project's cached kickoff lives. Regenerated only when its inputs (the
// inherited memory + brief) change — the brief is an LLM call, so we don't pay it
// on every project open.
function kickoffCacheFile(projectId: string): string {
  return path.join(process.cwd(), "workspace", "projects", projectId, "kickoff.json");
}

// draftKickoff — the day-one briefing. Assembles everything the firm already
// knows that applies to this project (sector playbook, client account lessons,
// stakeholder prefs, firm policy) plus the kick-off brief file, and turns it into
// a short "what we know going in" summary + three grounded starter questions.
// Cached against a signature of its inputs; pass {refresh:true} to force a rebuild
// (e.g. after intake adds facts).
export async function draftKickoff(projectId: string, user: string, opts?: { refresh?: boolean }): Promise<Kickoff> {
  const cfg = await getProjectConfig(projectId);
  const memory = await inheritedMemoryLines(projectId, user);
  const brief = await readFile(projectId, "brief.md").catch(() => "");

  // Signature of the inputs: if unchanged since last time, reuse the cached brief.
  const sig = createHash("sha1").update(`${user}\n${memory}\n${brief}`).digest("hex");
  const cacheFile = kickoffCacheFile(projectId);
  if (!opts?.refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as Kickoff & { sig?: string };
      if (cached.sig === sig) return { brief: cached.brief, questions: cached.questions };
    } catch {
      /* no cache yet */
    }
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      "You brief a consultant starting a project, using ONLY the inherited team memory and kick-off brief provided. " +
      "Write for a non-technical reader. Return STRICT JSON: " +
      `{"brief": string, "questions": string[]}. ` +
      "brief = 3-5 plain sentences on what we already know going in (the sector, this client, key people, firm approach); " +
      "if little is known, say so honestly and keep it short. " +
      "questions = exactly 3 short, specific starter questions the consultant could click to ask right now, " +
      "each motivated by something in the memory or brief. No preamble, JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Project: ${cfg.name} — client "${cfg.client}", sector ${cfg.sector}, type ${cfg.type}.\n\n` +
          `Inherited team memory:\n${memory || "(none yet)"}\n\n` +
          `Kick-off brief:\n${brief ? brief.slice(0, 2000) : "(no brief file)"}\n\nJSON:`,
      },
    ],
  });
  const parsed = parseJsonObject<Kickoff>(textOf(response), { brief: "", questions: [] });
  const result: Kickoff = {
    brief: typeof parsed.brief === "string" ? parsed.brief.trim() : "",
    questions: Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string").slice(0, 3) : [],
  };
  await fs.writeFile(cacheFile, JSON.stringify({ sig, ...result }, null, 2), "utf8").catch(() => {});
  return result;
}

export type FileSuggestions = { questions: string[]; gaps: string[] };

// suggestFromFile — turn a just-uploaded file into momentum: a couple of
// questions the consultant can now answer from it, and any obvious gaps worth
// noting. Grounded strictly in the file's own content.
export async function suggestFromFile(projectId: string, filePath: string): Promise<FileSuggestions> {
  const content = await readFile(projectId, filePath).catch(() => "");
  if (!content.trim()) return { questions: [], gaps: [] };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      "A consultant just added a document to a project. Using ONLY its content, return STRICT JSON: " +
      `{"questions": string[], "gaps": string[]}. ` +
      "questions = 2-3 short, specific questions this document now lets them ask (things it can answer). " +
      "gaps = 0-2 short notes on what it notably does NOT cover. JSON only, no preamble.",
    messages: [{ role: "user", content: `Document "${filePath}":\n${content.slice(0, 4000)}\n\nJSON:` }],
  });
  const parsed = parseJsonObject<FileSuggestions>(textOf(response), { questions: [], gaps: [] });
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string").slice(0, 3) : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === "string").slice(0, 2) : [],
  };
}

// intakeQuestions — a short, friendly kickoff interview tailored to this kind of
// project. Answers seed project memory, so ask the few things that make every
// later answer better: the goal, the key people, the hard constraints.
export async function intakeQuestions(projectId: string): Promise<string[]> {
  const cfg = await getProjectConfig(projectId);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 250,
    system:
      "You are kicking off a new consulting project. Propose exactly 3 short intake questions whose answers " +
      "would make future help sharply better — focus on the objective / what success looks like, the key people " +
      `and how they decide, and the hard constraints (deadlines, budget, red lines). Tailor them to a ${cfg.type} ` +
      `project in ${cfg.sector}. Return STRICT JSON: {"questions": string[]}. JSON only.`,
    messages: [{ role: "user", content: `Project: ${cfg.name} (client "${cfg.client}"). JSON:` }],
  });
  const parsed = parseJsonObject<{ questions: string[] }>(textOf(response), { questions: [] });
  return Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string").slice(0, 3) : [];
}

// distillFacts — turn free-text intake answers into clean, one-sentence project
// facts suitable for memory. Drops empties; keeps only the durable substance.
export async function distillFacts(projectId: string, answers: { question: string; answer: string }[]): Promise<string[]> {
  const filled = answers.filter((a) => a.answer.trim());
  if (filled.length === 0) return [];
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      "Turn each answered kickoff question into ONE durable, self-contained fact about the project, phrased so it " +
      "reads well out of context (include the subject, not just 'yes'). Skip anything vague or non-durable. " +
      `Return STRICT JSON: {"facts": string[]}. JSON only.`,
    messages: [
      {
        role: "user",
        content:
          filled.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n\n") + "\n\nJSON:",
      },
    ],
  });
  const parsed = parseJsonObject<{ facts: string[] }>(textOf(response), { facts: [] });
  return Array.isArray(parsed.facts) ? parsed.facts.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()) : [];
}

// LLM-as-reranker: reorder retrieved passages by true relevance and return the
// indices of the best few, best first. This is what makes the vector comparison
// honest (naïve top-k alone is rough).
export async function rerank(query: string, passages: string[], topN = 3): Promise<number[]> {
  const numbered = passages.map((p, i) => `[${i}] ${p.slice(0, 400)}`).join("\n\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 60,
    system:
      "You are a reranker. Given a query and numbered passages, return ONLY a JSON array of the passage indices most relevant to the query, best first.",
    messages: [{ role: "user", content: `Query: ${query}\n\nPassages:\n${numbered}\n\nTop ${topN} indices as JSON:` }],
  });
  try {
    const match = textOf(response).match(/\[[\d,\s]*\]/);
    const arr = match ? (JSON.parse(match[0]) as number[]) : [];
    const valid = arr.filter((i) => Number.isInteger(i) && i >= 0 && i < passages.length);
    return valid.length ? valid.slice(0, topN) : passages.map((_, i) => i).slice(0, topN);
  } catch {
    return passages.map((_, i) => i).slice(0, topN);
  }
}
