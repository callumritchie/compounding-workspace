/* POST /api/memory/touch { scope, id } → snooze a stale memory (stamp last_used
   to now) so it drops off the "suggest archiving" list without changing its
   usefulness score. */

import { touchMemory } from "@/lib/memory";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const scope = b?.scope;
  const id = b?.id;
  if (typeof scope !== "string" || typeof id !== "string")
    return Response.json({ error: "missing scope/id" }, { status: 400 });
  const ok = await touchMemory(scope, id);
  return Response.json({ ok });
}
