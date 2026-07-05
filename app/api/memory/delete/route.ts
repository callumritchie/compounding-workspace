/* POST /api/memory/delete  { scope, id }
   → permanently delete a memory file from the manager. Returns { ok }. */

import { deleteMemory } from "@/lib/memory";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const scope = b?.scope;
  const id = b?.id;
  if (typeof scope !== "string" || typeof id !== "string") {
    return Response.json({ error: "missing scope/id" }, { status: 400 });
  }
  const ok = await deleteMemory(scope, id);
  return Response.json({ ok });
}
