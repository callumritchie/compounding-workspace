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
import { TOOLS, DEEP_TOOLS, executeTool, type TraceEntry } from "./tools";
import { getMemoriesForContext } from "./memory";
import { readFile, listFiles } from "./corpus";
import { getProjectConfig } from "./project";
import { getEngagement, engagementDigest } from "./engagement";
import { getObjectives } from "./objectives";

// The reasoning engine. `claude-opus-4-8` is Anthropic's most capable Opus model,
// used for the main agent loop. FAST_MODEL (Haiku) handles the cheap auxiliary
// calls — reranking, classification, the compass/kickoff generators — where the
// full model isn't needed. Tiering these is a big latency/cost win (see Phase E).
const MODEL = "claude-opus-4-8";
const FAST_MODEL = "claude-haiku-4-5";

// Stable persona + how to use the tools. Kept stable so it can be cached later.
// Exported so the chat route can estimate its token weight for the composition bar.
export const SYSTEM_BASE = `You are an AI teammate inside a consulting team's shared workspace.
You help consultants think through client projects using the project's files:
interviews, notes, hypotheses, and research.

You have tools to navigate the SHARED corpus: list_files, read_file, search_files,
semantic_search, and write_file. Ground your answers in the real files — prefer
reading them over guessing. Choose the right tool deliberately:
  • read_file — when the user points at a file ("this", "that doc") or you already
    know the exact path. Resolve "this"/"the doc" from the WORKING CONTEXT block.
  • semantic_search — for conceptual or open-ended questions, or when the user's
    wording likely differs from the documents' ("willingness to pay" vs "pricing
    sensitivity"). It reranks to the best passages, so trust its top results.
  • search_files — for exact names, figures, or literal phrases you expect verbatim.
  • list_files — when you need to see what exists first.
When an answer spans several files, gather from each and synthesise rather than
answering from one. Only use write_file when the user asks you to create or save
something.

You also have long-term MEMORY. Facts you already know appear in the MEMORY section
of this prompt — respect them and weigh each by its trust label. When the user tells
you a durable preference, client fact, or lesson worth keeping, use save_memory so
you remember it next time.

When an ENGAGEMENT CONSTRAINTS block is present, treat it as the real-world frame:
weigh every recommendation against the budget, timeline, scope, and team capacity.
If a suggestion (yours or the user's) would strain one — e.g. it can't land before an
at-risk milestone, it pushes budget, or it falls under scope OUT with no change
request — say so in one short line that cites the specific constraint, then still give
your best substantive answer. Don't let constraints stop you from thinking; use them
to make the advice land in reality. Be concise, direct, and practical.`;

// Web search is OFF by default and, when the user turns it on, tightly fenced:
// these are research engagements, so external material must never be mistaken for —
// or blended into — the project's own research. This clause is appended to the
// system prompt only when the user has enabled search for the conversation.
export const WEB_SEARCH_GUARDRAIL = `EXTERNAL WEB SEARCH is enabled for this conversation. Use it ONLY for context that legitimately lives outside the project corpus — background on the client or its sector, or methodology questions — never to answer questions the project's own files should answer.
Rules you must follow:
  • Before searching, say in one short line WHAT you're about to look up externally and WHY, so the user stays in control.
  • Clearly label anything drawn from the web as "🌐 EXTERNAL" and keep it in its own part of the answer — never present external material as the project's research or blend the two.
  • NEVER save external content to the corpus (write_file) or to memory (save_memory). External context is for the conversation only; it must not enter the research record.
If web search isn't clearly appropriate, don't use it — answer from the project files.`;

// The Anthropic server-side web search tool. Server-executed: results come back as
// server_tool_use / web_search_tool_result blocks and NEVER pass through this app's
// client-side executeTool — so they are structurally incapable of reaching
// write_file or save_memory. That server/client split is the quarantine.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 5 } as const;

// The SDK reads ANTHROPIC_API_KEY from the environment (including .env.local).
const client = new Anthropic();

// Streaming events emitted as the agent works (for the live view).
export type PlanStep = { step: string; status: "pending" | "in_progress" | "done" };
export type AgentEvent =
  | { type: "step"; n: number }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown>; summary: string }
  // Deep-agent events: the plan the agent is working to, and the sub-agents it
  // delegates to (with their own tool calls surfaced as nested steps).
  | { type: "plan"; todos: PlanStep[] }
  | { type: "delegate"; phase: "start" | "end"; agent: string; task?: string; summary?: string }
  | { type: "subtool"; agent: string; name: string; summary: string };

// What the agent returns: the final answer, a trace of the tools it used, token
// usage (summed across every model call in the turn), and the reasoning summary.
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type AgentResult = { text: string; trace: TraceEntry[]; usage: Usage; reasoning: string };

// The agent loop. Streams as it goes: pass `onEvent` to receive thinking / tool /
// text events live; omit it to just run to completion (used by the eval + compare).
export type AgentSpec = { systemPrompt: string; model: string; toolNames?: string[] };
// A specialist the lead agent may delegate to. Resolved from the roster by the
// caller (the chat route) and passed in, so agent.ts needn't import agents.ts.
export type SubagentSpec = { id: string; name: string; systemPrompt: string; model: string; toolNames?: string[] };

export async function runAgent(
  messages: Message[],
  opts: {
    projectId: string;
    user: string;
    stableBlock?: string;
    volatileBlock?: string;
    agent?: AgentSpec; // which agent (persona/model/tools); omitted → the default
    subagents?: SubagentSpec[]; // specialists the agent may `delegate` to (deep agents only)
    webSearch?: boolean; // opt-in external web search (off by default; quarantined + guarded)
  },
  onEvent?: (ev: AgentEvent) => void
): Promise<AgentResult> {
  // Resolve the agent harness: its system prompt, model, and the subset of tools
  // it may call. Omitting `agent` (eval + compare) keeps the shipped defaults.
  const persona = opts.agent?.systemPrompt ?? SYSTEM_BASE;
  const model = opts.agent?.model || MODEL;
  // The deep-agent tools (update_plan/delegate) are only offered to an agent that
  // explicitly lists them. The default/eval path (no agent spec) gets exactly the
  // original TOOLS, so it stays byte-identical and the golden-set gate is unaffected.
  const catalogue = opts.agent ? [...TOOLS, ...DEEP_TOOLS] : TOOLS;
  const tools =
    opts.agent?.toolNames && opts.agent.toolNames.length
      ? catalogue.filter((t) => opts.agent!.toolNames!.includes(t.name))
      : TOOLS;

  // Order the prompt stable → volatile. The stable block (persona + constitution
  // + high-importance memory) sits behind a cache breakpoint; the volatile block
  // (ranked memory + working context) comes after and is never cached.
  const stableSystem = opts.stableBlock ? `${persona}\n\n${opts.stableBlock}` : persona;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
  ];
  if (opts.volatileBlock) system.push({ type: "text", text: opts.volatileBlock });
  // The web-search guardrail rides the volatile tier (per-conversation setting, so
  // it must not sit inside the cached prefix). Only present when the user opted in.
  if (opts.webSearch) system.push({ type: "text", text: WEB_SEARCH_GUARDRAIL });

  // Offer the server-side web search tool ONLY when the user enabled it. Typed as
  // the tool union so the custom tools and the server tool can share one array.
  const requestTools: Anthropic.ToolUnion[] = opts.webSearch ? [...tools, WEB_SEARCH_TOOL] : tools;

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
        tools: requestTools,
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

    // Surface any EXTERNAL web searches (server-executed) in the glass-box trace so
    // the user can see exactly what the agent looked up outside the corpus. These
    // blocks never touch executeTool — the results stay quarantined from the corpus.
    for (const b of response.content) {
      if (b.type === "server_tool_use" && b.name === "web_search") {
        const q = String((b.input as { query?: unknown })?.query ?? "");
        onEvent?.({ type: "tool", name: "web_search", input: { query: q }, summary: `🌐 EXTERNAL web search: "${q}"` });
        trace.push({ tool: "web_search", input: { query: q }, summary: `🌐 EXTERNAL web search: "${q}"`, result: "(external — not saved to corpus or memory)" });
      }
    }

    // Server tools run inside the model turn; if that server loop paused (hit its
    // iteration cap), resume by re-sending the assistant turn — don't treat it as done.
    if (response.stop_reason === "pause_turn") {
      convo.push({ role: "assistant", content: response.content });
      continue;
    }

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

      // --- Deep-agent built-ins (handled here, not in executeTool) ---

      // update_plan — the agent's visible, adaptive checklist. We just surface it
      // and ack; the plan lives in the trace so the x-ray shows the final state.
      if (tu.name === "update_plan") {
        const todos: PlanStep[] = Array.isArray(input.todos)
          ? (input.todos as unknown[])
              .map((t) => {
                const o = (t ?? {}) as { step?: unknown; status?: unknown };
                const status = o.status === "done" ? "done" : o.status === "in_progress" ? "in_progress" : "pending";
                return { step: String(o.step ?? "").trim(), status } as PlanStep;
              })
              .filter((t) => t.step)
          : [];
        onEvent?.({ type: "plan", todos });
        const doneN = todos.filter((t) => t.status === "done").length;
        trace.push({
          tool: "update_plan",
          input,
          summary: `plan · ${todos.length} step${todos.length === 1 ? "" : "s"}${doneN ? ` · ${doneN} done` : ""}`,
          result: todos.map((t) => `${t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${t.step}`).join("\n"),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Plan updated. Keep going — call update_plan again to mark steps done or revise the plan.",
        });
        continue;
      }

      // delegate — run a roster specialist in its OWN isolated context (a fresh
      // conversation with just the task; no access to this chat's history). It
      // gets the same project grounding, its own persona + tools, and cannot
      // itself plan/delegate (deep tools stripped → exactly one level deep).
      if (tu.name === "delegate") {
        const agentId = String(input.agent ?? "").trim();
        const task = String(input.task ?? "").trim();
        const sub = opts.subagents?.find((s) => s.id === agentId);
        if (!sub) {
          const known = (opts.subagents ?? []).map((s) => s.id).join(", ") || "none available";
          const msg = `Unknown specialist "${agentId}". Available: ${known}. Delegate to one of those, or do the work yourself.`;
          trace.push({ tool: "delegate", input, summary: `delegate failed — unknown "${agentId}"`, result: msg });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: msg });
          continue;
        }
        onEvent?.({ type: "delegate", phase: "start", agent: sub.name, task });
        const childTools = (sub.toolNames ?? []).filter((n) => n !== "update_plan" && n !== "delegate");
        const child = await runAgent(
          [{ role: "user", content: task }],
          {
            projectId: opts.projectId,
            user: opts.user,
            stableBlock: opts.stableBlock,
            volatileBlock: opts.volatileBlock,
            agent: { systemPrompt: sub.systemPrompt, model: sub.model, toolNames: childTools },
            // no `subagents` → the specialist can't delegate further (one level deep)
          },
          // Surface the specialist's tool calls as nested steps; suppress its token
          // stream so the parent live view stays legible — its answer returns below.
          (cev) => {
            if (cev.type === "tool") onEvent?.({ type: "subtool", agent: sub.name, name: cev.name, summary: cev.summary });
          }
        );
        usage.input += child.usage.input;
        usage.output += child.usage.output;
        usage.cacheRead += child.usage.cacheRead;
        usage.cacheWrite += child.usage.cacheWrite;
        onEvent?.({ type: "delegate", phase: "end", agent: sub.name, summary: child.text.slice(0, 160) });
        trace.push({
          tool: "delegate",
          input,
          summary: `delegated to ${sub.name} → ${child.trace.length} tool call${child.trace.length === 1 ? "" : "s"}`,
          result: child.text.slice(0, 900),
        });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `${sub.name} reports:\n\n${child.text}` });
        continue;
      }

      // --- Regular corpus/memory tools ---
      const { result, summary } = await executeTool(
        { projectId: opts.projectId, user: opts.user },
        tu.name,
        input
      );
      // Keep retrieval results long enough that the x-ray's RAG panel can show the
      // passages that were pulled; other tools stay tightly capped to keep the
      // persisted trace small.
      const cap = tu.name === "semantic_search" || tu.name === "search_files" ? 900 : 300;
      trace.push({ tool: tu.name, input, summary, result: result.slice(0, cap) });
      onEvent?.({ type: "tool", name: tu.name, input, summary });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { text: "(stopped after too many tool steps)", trace, usage, reasoning };
}

// Non-streaming wrapper — used by the eval harness.
export async function respond(
  messages: Message[],
  opts: { projectId: string; user: string; stableBlock?: string; volatileBlock?: string; agent?: AgentSpec }
): Promise<AgentResult> {
  return runAgent(messages, opts);
}

// Confidentiality leak check at promotion time. The substring check (leakCheck in
// promotion.ts) catches literal client names; this LLM pass catches what substring
// can't — paraphrased names, and STRUCTURAL identifiers (a distinctive metric,
// a one-of-a-kind strategy) that could still fingerprint the client. Returns a
// verdict + short reasons. Fails "open but flagged" on error so a model hiccup
// never silently green-lights a leak.
export async function leakCheckLLM(text: string, clientName: string): Promise<{ flagged: boolean; reasons: string[] }> {
  try {
    const response = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 200,
      system:
        "You are a confidentiality reviewer for a consultancy's SHARED knowledge base. A lesson is about to be promoted " +
        "to a scope other consultants can see. Flag it if anything could identify the originating client — the client " +
        "name (even paraphrased), or a STRUCTURAL identifier like a distinctive metric, deal size, named person, or a " +
        "one-of-a-kind strategy. General, transferable insight is fine. Return STRICT JSON: " +
        `{"flagged": boolean, "reasons": string[]}. reasons = short phrases naming what could identify the client (empty if clean). JSON only.`,
      messages: [{ role: "user", content: `Originating client: ${clientName}\n\nLesson to promote:\n${text}\n\nJSON:` }],
    });
    const parsed = parseJsonObject<{ flagged: boolean; reasons: string[] }>(textOf(response), { flagged: false, reasons: [] });
    return {
      flagged: !!parsed.flagged,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((r) => typeof r === "string").slice(0, 5) : [],
    };
  } catch {
    // Fail "flagged" so a model hiccup never silently green-lights a leak.
    return { flagged: true, reasons: ["leak-check unavailable — review manually before promoting"] };
  }
}

// Abstraction step used at promotion time: turn a project-specific lesson into a
// general, reusable one — stripping client names and identifying specifics.
export async function abstractLesson(fact: string, clientName: string, scopeLabel: string): Promise<string> {
  const response = await client.messages.create({
    // Opus: abstraction is confidentiality-sensitive (it must reliably strip
    // identifying detail while preserving the transferable insight) — worth the
    // stronger model even though it's an auxiliary call.
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
  const objectives = await getObjectives(projectId);
  const objectivesText = objectives?.length ? objectives.map((o) => `- ${o}`).join("\n") : "";

  // Signature of the inputs: if unchanged since last time, reuse the cached brief.
  const sig = createHash("sha1").update(`${user}\n${memory}\n${brief}\n${objectivesText}`).digest("hex");
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
    model: FAST_MODEL,
    max_tokens: 600,
    system:
      "You brief a consultant starting a project, using ONLY the objectives, inherited team memory and kick-off brief provided. " +
      "Write for a non-technical reader. Return STRICT JSON: " +
      `{"brief": string, "questions": string[]}. ` +
      "brief = 3-5 plain sentences on what we already know going in (the engagement's objectives, the sector, this client, key people, firm approach); " +
      "lead with what success looks like per the objectives; if little is known, say so honestly and keep it short. " +
      "questions = exactly 3 short, specific starter questions the consultant could click to ask right now, " +
      "each motivated by something in the objectives, memory or brief. No preamble, JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Project: ${cfg.name} — client "${cfg.client}", sector ${cfg.sector}, type ${cfg.type}.\n\n` +
          `Objectives (the signed-off north star):\n${objectivesText || "(none stated)"}\n\n` +
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
    model: FAST_MODEL,
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
    model: FAST_MODEL,
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
    model: FAST_MODEL,
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

/* ---------------------------------------------------------------------------
   inferNextActions — the "Compass". Levels the playing field: instead of leaving
   the user to know what to ask, we read the real state (project, inherited
   memory, corpus, recent activity) and infer WHERE this engagement is + the best
   next moves. Two deliberate guards against funnelling the user down a wrong path:
     • the STAGE is flexible (named to fit THIS project, not a fixed pipeline) and
       carries a rationale, so it's legible and contestable, not silently decided;
     • the ACTIONS are plural, diverse, and each grounded in a "why" — breadth,
       not a single prescriptive path.
   Also returns at most ONE proactive `offer` (something the agent could just do
   now) for the bottom-right nudge — capped + dismissible by design.
--------------------------------------------------------------------------- */

export type NextAction = { title: string; prompt: string; why: string; kind?: "action" | "question" };
export type NextActions = {
  stage: { label: string; rationale: string };
  actions: NextAction[];
  offer: NextAction | null;
};

const EMPTY_NEXT: NextActions = { stage: { label: "", rationale: "" }, actions: [], offer: null };

function compassCacheFile(projectId: string): string {
  return path.join(process.cwd(), "workspace", "projects", projectId, "compass.json");
}

// `recent` = a compact digest of what the user has been doing (last few messages
// + actions), assembled by the route. Cached against a signature of all inputs so
// an unchanged state costs nothing; the state moves each turn, so it refreshes.
export async function inferNextActions(projectId: string, user: string, recent: string): Promise<NextActions> {
  const cfg = await getProjectConfig(projectId);
  const memory = await inheritedMemoryLines(projectId, user);
  const files = await listFiles(projectId).catch(() => [] as string[]);
  const fileList = files.length ? files.join(", ") : "(no files yet)";
  // Constraints make the suggestions realistic — a next step that can't land before
  // an at-risk milestone, or that pushes budget/scope, is worth surfacing.
  const engagement = await getEngagement(projectId);
  const constraints = engagement ? engagementDigest(engagement) : "";

  const sig = createHash("sha1").update(`${user}\n${memory}\n${fileList}\n${constraints}\n${recent}`).digest("hex");
  const cacheFile = compassCacheFile(projectId);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as NextActions & { sig?: string };
    if (cached.sig === sig) return { stage: cached.stage, actions: cached.actions, offer: cached.offer ?? null };
  } catch {
    /* no cache yet */
  }

  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 1500, // room for stage + 3-4 full-sentence actions + an offer, so the JSON never truncates
    system:
      "You guide a consultant through a client engagement by inferring, from the real state below, WHERE the " +
      "project is and the best next moves. Write for a non-technical reader. Return STRICT JSON: " +
      `{"stage":{"label":string,"rationale":string},"actions":[{"title":string,"prompt":string,"why":string,"kind":"action"|"question"}],"offer":{"title":string,"prompt":string,"why":string}}. ` +
      "stage.label = a SHORT phase name that fits THIS specific project — engagements vary hugely, so name whatever " +
      "actually fits (e.g. 'Scoping', 'Stakeholder discovery', 'Diligence red-flags', 'Synthesis', 'Recommendation', " +
      "'Board-ready') rather than forcing a fixed pipeline. stage.rationale = one plain sentence citing the signals. " +
      "actions = exactly 4 GENUINELY DIFFERENT items (not variants of one) that BLEND two kinds — roughly half " +
      "kind:'action' (an imperative next step the agent should DO) and half kind:'question' (a relevant follow-on the " +
      "user could ASK to see what this product can do for them: surface a hidden risk, stress-test the case, compare " +
      "options, find a gap). Each item: title (≤6 words — imperative for actions, phrased as a question for questions), " +
      "prompt (the exact message to send the agent), why (one short clause grounded in the state, e.g. 'the COO " +
      "interview isn't synthesised yet'), kind. Questions must be as grounded and specific as actions — never generic. " +
      "offer = the SINGLE most useful thing the agent could just do now on the " +
      "user's behalf (same shape, no kind), or null if nothing clearly warrants it. Be concrete and grounded in the inputs; " +
      "never invent files or facts. If the engagement constraints show something under pressure (an at-risk milestone, " +
      "budget strain, an out-of-scope ask), let that shape the stage and at least one item. JSON only, no preamble.",
    messages: [
      {
        role: "user",
        content:
          `Project: ${cfg.name} — client "${cfg.client}", sector ${cfg.sector}, type ${cfg.type}, status ${cfg.status}.\n\n` +
          (constraints ? `${constraints}\n\n` : "") +
          `Files in the corpus: ${fileList}\n\n` +
          `What the team already knows (inherited memory):\n${memory || "(none yet)"}\n\n` +
          `Recent activity in this chat:\n${recent || "(nothing yet)"}\n\nJSON:`,
      },
    ],
  });

  const parsed = parseJsonObject<NextActions>(textOf(response), EMPTY_NEXT);
  const cleanAction = (a: unknown): NextAction | null => {
    const o = a as Partial<NextAction>;
    return o && typeof o.title === "string" && typeof o.prompt === "string"
      ? {
          title: o.title.trim(),
          prompt: o.prompt.trim(),
          why: typeof o.why === "string" ? o.why.trim() : "",
          kind: o.kind === "question" ? "question" : "action",
        }
      : null;
  };
  const result: NextActions = {
    stage: {
      label: typeof parsed.stage?.label === "string" ? parsed.stage.label.trim() : "",
      rationale: typeof parsed.stage?.rationale === "string" ? parsed.stage.rationale.trim() : "",
    },
    actions: Array.isArray(parsed.actions)
      ? parsed.actions.map(cleanAction).filter((a): a is NextAction => a !== null).slice(0, 4)
      : [],
    offer: cleanAction(parsed.offer),
  };
  await fs.writeFile(cacheFile, JSON.stringify({ sig, ...result }, null, 2), "utf8").catch(() => {});
  return result;
}
