/* POST /api/chat  { user, message, project?, openFile?, recentActions? }
   → runs one agentic chat turn for that user.

   Steps:
     1. load the user's PRIVATE history, append their message
     2. assemble WORKING CONTEXT (open file + recent actions)
     3. run the agent loop (it may read/search/write shared files)
     4. save history; return updated history + the tool trace + the file list
        (the list may have changed if the agent wrote a file)
*/

import { getHistory, saveHistory, isUser, type Message } from "@/lib/workspace";
import { respond, SYSTEM_BASE } from "@/lib/agent";
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

  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!message) return Response.json({ error: "empty message" }, { status: 400 });

  const history = await getHistory(user);
  history.push({ role: "user", content: message });

  const workingContext = buildWorkingContext({ projectId: project, openFile, recentActions });

  // Assemble memory (labelled, split into cache-stable + query-ranked tiers,
  // budgeted) for THIS user + project — see lib/assemble.ts.
  const memories = await getMemoriesForContext(user, project);
  const assembled = assembleContext(memories, workingContext);

  // Break the input prompt into its parts so the glass box can VISUALISE what
  // fills the context window. The first three parts sit behind the cache
  // breakpoint (reused free next turn); the rest are re-sent every turn.
  // (history here excludes the just-added user message, which is its own part.)
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

  let text: string;
  let trace;
  let usage;
  try {
    ({ text, trace, usage } = await respond(history, {
      projectId: project,
      user,
      stableBlock: assembled.stableBlock,
      volatileBlock: assembled.volatileBlock,
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return Response.json({ error: detail }, { status: 500 });
  }

  const assistantMessage: Message = { role: "assistant", content: text };
  history.push(assistantMessage);
  await saveHistory(user, history);

  const files = await listFiles(project);
  const context = { ...assembled.report, usage, composition };
  return Response.json({ history, trace, files, context });
}
