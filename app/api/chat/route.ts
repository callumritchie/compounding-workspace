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
  chatProject,
  isUser,
  type Message,
} from "@/lib/workspace";
import { runAgent, type AgentEvent } from "@/lib/agent";
import { buildWorkingContext } from "@/lib/context";
import { getEngagement, engagementDigest } from "@/lib/engagement";
import { getObjectives, objectivesDigest } from "@/lib/objectives";
import { recordReuse } from "@/lib/reuse";
import { assembleContext, estimateTokens } from "@/lib/assemble";
import { getRelevantMemories, recordMemoryUse, graduateOnUse } from "@/lib/memory";
import { getProjectConfig } from "@/lib/project";
import { getAgent, listAgents } from "@/lib/agents";
import { TOOLS, DEEP_TOOLS } from "@/lib/tools";
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
  const webSearch: boolean = body?.webSearch === true; // off unless the user explicitly enabled it

  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!message) return Response.json({ error: "empty message" }, { status: 400 });
  if (!chatId) return Response.json({ error: "missing chatId" }, { status: 400 });

  const history = await getChatHistory(user, chatId);
  history.push({ role: "user", content: message });

  // What this user's OTHER tabs IN THIS PROJECT are working on (cross-tab awareness
  // is scoped to the project, so a chat never "sees" work on a different engagement).
  const allChats = await listChats(user);
  const otherTabs = allChats
    .filter((c) => c.chatId !== chatId && chatProject(c) === project)
    .map((c) => ({ title: c.title, openFile: c.openFile, lastActivity: c.lastUserMessage }));

  const projectCfg = await getProjectConfig(project);
  const workingContext = buildWorkingContext({
    projectId: project,
    openFile,
    recentActions,
    otherTabs,
    stakeholders: projectCfg.stakeholders,
  });

  // Which agent is this chat running? (Its persona/model/tools drive the turn.)
  const chatMeta = allChats.find((c) => c.chatId === chatId);
  const agent = await getAgent(chatMeta?.agentId);
  const agentTools = agent.tools?.length
    ? [...TOOLS, ...DEEP_TOOLS].filter((t) => agent.tools.includes(t.name))
    : TOOLS;

  // The other roster agents are available as sub-agents the current agent may
  // delegate to (only a deep agent with the `delegate` tool will actually use them).
  const roster = await listAgents();
  const subagents = roster
    .filter((a) => a.id !== agent.id)
    .map((a) => ({ id: a.id, name: a.name, systemPrompt: a.systemPrompt, model: a.model, toolNames: a.tools }));

  // Retrieve the RELEVANT in-scope memories for this question (constitution +
  // pinned always; learned by embedding relevance within the scope lattice), then
  // assemble them into the cache-stable + volatile tiers.
  const memories = await getRelevantMemories(user, project, message);
  const assembled = assembleContext(memories, workingContext);

  // Engagement constraints (SOW / budget / timeline / scope / team / risks) are
  // STANDING context — they bear on every recommendation, so they ride the volatile
  // tier every turn (present whether or not the question mentions them). Absent for
  // projects with no engagement.md.
  const engagement = await getEngagement(project);
  const engagementBlock = engagement ? engagementDigest(engagement) : "";

  // Objectives are the engagement's NORTH STAR (files/objectives.md). Like the
  // constraints they're standing context, so they lead the volatile block every
  // turn — the agent should keep its work in service of them.
  const objectives = await getObjectives(project);
  const objectivesBlock = objectives ? objectivesDigest(objectives) : "";

  const volatileBlock = [objectivesBlock, engagementBlock, assembled.volatileBlock].filter(Boolean).join("\n\n");

  // Break the input prompt into parts for the composition bar.
  const priorHistory = history.slice(0, -1).map((m) => m.content).join("\n");
  const composition = [
    { label: "Persona", tokens: estimateTokens(agent.systemPrompt), tier: "cached" },
    { label: "Tool schemas", tokens: estimateTokens(JSON.stringify(agentTools)), tier: "cached" },
    { label: "Stable memory", tokens: estimateTokens(assembled.stableBlock), tier: "cached" },
    { label: "Objectives", tokens: estimateTokens(objectivesBlock), tier: "volatile" },
    { label: "Engagement constraints", tokens: estimateTokens(engagementBlock), tier: "volatile" },
    { label: "Ranked memory", tokens: estimateTokens(assembled.rankedBlock), tier: "volatile" },
    { label: "Working context", tokens: estimateTokens(workingContext), tier: "volatile" },
    { label: "History", tokens: estimateTokens(priorHistory), tier: "volatile" },
    { label: "Current message", tokens: estimateTokens(message), tier: "volatile" },
  ].filter((s) => s.tokens > 0);

  const injected = assembled.report.injected.map((m) => ({
    id: m.id,
    scope: m.scope,
    type: m.type,
    tier: m.tier,
    text: m.text,
  }));

  // Usage signal: record that these memories were actually injected this turn
  // (fire-and-forget; powers "most-used" sorting + staleness). Not on the hot path.
  const injectedRefs = injected.map((m) => ({ scope: m.scope, id: m.id }));
  void recordMemoryUse(injectedRefs);

  // Reuse signal (C1): a LEARNED memory whose scope sits ABOVE this project on the
  // lattice (company / sector / client / stakeholder) is firm knowledge learned
  // ELSEWHERE, now applied here — the compounding. Log it for the impact metric.
  const reuses = injected
    .filter((m) => m.type === "learned" && !m.scope.startsWith("project/") && !m.scope.startsWith("personal/"))
    .map((m) => ({ memoryId: m.id, scope: m.scope, sourceProject: null, targetProject: project, actor: user }));
  void recordReuse(reuses);
  // Graduation signal: any provisional memory leaned on here moves one step closer
  // to becoming trusted — earning its place through use, not an approval click.
  void graduateOnUse(injectedRefs);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const result = await runAgent(
          history,
          {
            projectId: project,
            user,
            stableBlock: assembled.stableBlock,
            volatileBlock,
            agent: { systemPrompt: agent.systemPrompt, model: agent.model, toolNames: agent.tools },
            subagents,
            webSearch,
          },
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
