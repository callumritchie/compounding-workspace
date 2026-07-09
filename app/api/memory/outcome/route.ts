/* POST /api/memory/outcome  { scope, id, worked, user }
   → outcome-based reinforcement: mark whether a memory's guidance actually worked.
   Importance moves on correctness, not usage (ticket C3). Returns { ok }. */

import { reinforceOutcome } from "@/lib/memory";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  if (typeof b?.scope !== "string" || typeof b?.id !== "string" || typeof b?.worked !== "boolean") {
    return Response.json({ error: "missing scope/id/worked" }, { status: 400 });
  }
  const ok = await reinforceOutcome(b.scope, b.id, b.worked, typeof b.user === "string" ? b.user : undefined);
  return Response.json({ ok });
}
