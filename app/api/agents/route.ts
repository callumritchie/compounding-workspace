/* GET /api/agents → the agent roster (default first). */

import { listAgents, DEFAULT_AGENT_ID } from "@/lib/agents";
import { TOOLS } from "@/lib/tools";

export async function GET() {
  const agents = await listAgents();
  const allTools = TOOLS.map((t) => ({ name: t.name, description: t.description ?? "" }));
  return Response.json({ agents, defaultId: DEFAULT_AGENT_ID, allTools });
}
