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
import type { Message } from "./workspace";
import { TOOLS, executeTool, type TraceEntry } from "./tools";

// The reasoning engine. `claude-opus-4-8` is Anthropic's most capable Opus model.
const MODEL = "claude-opus-4-8";

// Stable persona + how to use the tools. Kept stable so it can be cached later.
const SYSTEM_BASE = `You are an AI teammate inside a consulting team's shared workspace.
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

// What the agent returns: the final answer, plus a trace of the tools it used
// (so the glass-box panel can show its work).
// Token usage, summed across every model call in one turn (the tool loop can
// call the model several times). Lets the glass box show cost + caching.
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type AgentResult = { text: string; trace: TraceEntry[]; usage: Usage };

export async function respond(
  messages: Message[],
  opts: { projectId: string; user: string; stableBlock?: string; volatileBlock?: string }
): Promise<AgentResult> {
  // Order the prompt stable → volatile. The stable block (persona + constitution
  // + high-importance memory) sits behind a cache breakpoint; the volatile block
  // (ranked memory + working context) comes after and is never cached.
  const stableSystem = opts.stableBlock ? `${SYSTEM_BASE}\n\n${opts.stableBlock}` : SYSTEM_BASE;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
  ];
  if (opts.volatileBlock) system.push({ type: "text", text: opts.volatileBlock });

  // The running conversation. We start from history and append the model's
  // tool-use turns and our tool-result turns as the loop runs.
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: TraceEntry[] = [];
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  // Safety cap: never loop more than this many model calls in one turn.
  for (let step = 0; step < 8; step++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: "adaptive" }, // let the model think as much as the task needs
        system,
        tools: TOOLS,
        messages: convo,
      });
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
      return { text: text || "(no response)", trace, usage };
    }

    // Append the model's turn EXACTLY as received (keeps thinking + tool_use
    // blocks intact — the API requires this when tools are used).
    convo.push({ role: "assistant", content: response.content });

    // Run every tool the model asked for and collect the results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const { result, summary } = await executeTool(
        { projectId: opts.projectId, user: opts.user },
        tu.name,
        input
      );
      trace.push({ tool: tu.name, input, summary });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { text: "(stopped after too many tool steps)", trace, usage };
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
