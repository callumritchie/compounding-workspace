/* POST /api/signals/status → mark an atom-backed signal dismissed / actioned, so the
   inbox can clear it. Only atom-backed signals (ids that exist in the store) persist;
   derived signals (churn/playbook/whitespace) recompute, so a dismiss is a no-op there. */

import { setAtomStatus } from "@/lib/signals/atoms";
import { canAccessSpace, canSeeDeliveryHealth } from "@/lib/team";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!canAccessSpace(user, "firm") && !canSeeDeliveryHealth(user)) {
    return Response.json({ error: "not authorised" }, { status: 403 });
  }
  const id = String(body.id ?? "");
  const status = ["actioned", "dismissed", "new"].includes(body.status) ? body.status : "dismissed";
  const ok = id ? setAtomStatus(id, status) : false;
  return Response.json({ ok });
}
