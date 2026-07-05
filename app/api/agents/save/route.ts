/* POST /api/agents/save { agent } → create or update an agent (by id). */

import { saveAgent, type Agent } from "@/lib/agents";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const a = b?.agent as Partial<Agent> | undefined;
  if (!a || typeof a.name !== "string") return Response.json({ error: "missing agent" }, { status: 400 });
  const saved = await saveAgent({
    id: typeof a.id === "string" ? a.id : "",
    name: a.name,
    description: typeof a.description === "string" ? a.description : "",
    systemPrompt: typeof a.systemPrompt === "string" ? a.systemPrompt : "",
    model: typeof a.model === "string" ? a.model : "claude-opus-4-8",
    tools: Array.isArray(a.tools) ? a.tools.filter((t): t is string => typeof t === "string") : [],
  });
  return Response.json({ ok: true, agent: saved });
}
