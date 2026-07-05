/* POST /api/memory/update  { scope, id, body?, importance?, status? }
   → edit a memory from the manager (text, importance, or retract/restore via
   status). Returns { ok }. */

import { updateMemory } from "@/lib/memory";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const scope = b?.scope;
  const id = b?.id;
  if (typeof scope !== "string" || typeof id !== "string") {
    return Response.json({ error: "missing scope/id" }, { status: 400 });
  }
  const patch: { body?: string; importance?: number; status?: string } = {};
  if (typeof b?.body === "string") patch.body = b.body;
  if (typeof b?.importance === "number") patch.importance = b.importance;
  if (typeof b?.status === "string") patch.status = b.status;
  const ok = await updateMemory(scope, id, patch);
  return Response.json({ ok });
}
