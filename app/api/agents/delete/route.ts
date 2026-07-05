/* POST /api/agents/delete { id } → remove an agent (the default can't be deleted). */

import { deleteAgent } from "@/lib/agents";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const id = b?.id;
  if (typeof id !== "string") return Response.json({ error: "missing id" }, { status: 400 });
  const ok = await deleteAgent(id);
  return Response.json({ ok });
}
