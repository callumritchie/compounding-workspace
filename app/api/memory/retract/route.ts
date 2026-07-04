/* POST /api/memory/retract  { scope, id }
   → marks a memory retracted so it is no longer injected (the "contest" path). */

import { retractMemory } from "@/lib/memory";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const scope = body?.scope;
  const id = body?.id;
  if (typeof scope !== "string" || typeof id !== "string") {
    return Response.json({ error: "missing scope/id" }, { status: 400 });
  }
  const ok = await retractMemory(scope, id);
  return Response.json({ ok });
}
