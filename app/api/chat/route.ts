/* POST /api/chat  { user, message, project?, openFile?, recentActions?, chatId }
   → runs one agentic chat turn and STREAMS it back as Server-Sent Events.

   Events: {type:"step"} · {type:"thinking",text} · {type:"tool",name,input,summary}
           · {type:"text",text} · {type:"done", history, trace, files, context}
           · {type:"error", error}

   The final `done` event carries the same payload the non-streaming version used
   to return, so the client can reconcile once the turn completes. Each assistant
   message is saved with a `meta` block (trace, reasoning, injected memory, usage,
   composition) for the per-message X-ray.
*/

import {
  getChatHistory,
  saveChatHistory,
  listChats,
  updateChatMeta,
  isUser,
  type Message,
} from "@/lib/workspace";
import { runAgent, SYSTEM_BASE, type AgentEvent } from "@/lib/agent";
import { buildWorkingContext } from "@/lib/context";
import { assembleContext, estimateTokens } from "@/lib/assemble";
import { getMemoriesForContext } from "@/lib/memory";
import { TOOLS } from "@/lib/tools";
import { listFiles, DEFAULT_PROJECT } from "@/lib/corpus";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = body?.user;
  const message: string = (body?.message ?? "").trim();
  const project: string = typeof body?.project === "string" ? body.project : DEFAULT_PROJECT;
  const openFile: string | null = typeof body?.openFile === "string" ? body.openFile : null;
  const recentActions: string[] = Array.isArray(body?.recentActions)
    ? body.recentActions.filter((x: unknown): x is string => typeof x === "string")
    : [];
  const chatId: string | null = typeof body?.chatId === "string" ? body.chatId : null;

  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!message) return Response.json({ error: "empty message" }, { status: 400 });
  if (!chatId) return Response.json({ error: "missing chatId" }, { status: 400 });

  const history = await getChatHistory(user, chatId);
  history.push({ role: "user", content: message });

  // What this user's OTHER tabs are working on — compact cross-tab awareness.
  const allChats = await listChats(user);
  const otherTabs = allChats
    .filter((c) => c.chatId !== chatId)
    .map((c) => ({ title: c.title, openFile: c.openFile, lastActivity: c.lastUserMessage }));

  const workingContext = buildWorkingContext({ projectId: project, openFile, recentActions, otherTabs });

  // Assemble memory (labelled, split into cache-stable + query-ranked tiers).
  const memories = await getMemoriesForContext(user, project);
  const assembled = assembleContext(memories, workingContext);

  // Break the input prompt into parts for the composition bar.
  const priorHistory = history.slice(0, -1).map((m) => m.content).join("\n");
  const composition = [
    { label: "Persona", tokens: estimateTokens(SYSTEM_BASE), tier: "cached" },
    { label: "Tool schemas", tokens: estimateTokens(JSON.stringify(TOOLS)), tier: "cached" },
    { label: "Stable memory", tokens: estimateTokens(assembled.stableBlock), tier: "cached" },
    { label: "Ranked memory", tokens: estimateTokens(assembled.rankedBlock), tier: "volatile" },
    { label: "Working context", tokens: estimateTokens(workingContext), tier: "volatile" },
    { label: "History", tokens: estimateTokens(priorHistory), tier: "volatile" },
    { label: "Current message", tokens: estimateTokens(message), tier: "volatile" },
  ].filter((s) => s.tokens > 0);

  const injected = assembled.report.injected.map((m) => ({ scope: m.scope, tier: m.tier, text: m.text }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const result = await runAgent(
          history,
          { projectId: project, user, stableBlock: assembled.stableBlock, volatileBlock: assembled.volatileBlock },
          (ev: AgentEvent) => send(ev)
        );

        const meta = {
          trace: result.trace,
          reasoning: result.reasoning,
          injected,
          usage: result.usage,
          composition,
        };
        const assistantMessage: Message = { role: "assistant", content: result.text, meta };
        history.push(assistantMessage);
        await saveChatHistory(user, chatId, history);

        // Update this tab's metadata (auto-title, last message, open file).
        const currentMeta = allChats.find((c) => c.chatId === chatId);
        const hasTitle = currentMeta?.title && currentMeta.title !== "New chat";
        const title = hasTitle ? currentMeta!.title : message.slice(0, 40);
        await updateChatMeta(user, chatId, { title, lastUserMessage: message, openFile, updated: new Date().toISOString() });

        const files = await listFiles(project);
        const context = { ...assembled.report, usage: result.usage, composition };
        send({ type: "done", history, trace: result.trace, files, context });
      } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown error";
        send({ type: "error", error: detail });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
