/* GET /api/signals/inbox?user= → the prioritized, role-gated signal inbox across
   every family (buying / competitive / objection / churn / early-warning /
   delivery-health / risk-playbook / new-service-line). Firm-authorised roles or the
   delivery lead only; each family is further gated + de-identified inside buildInbox. */

import { buildInbox } from "@/lib/signals/inbox";
import { canAccessSpace, canSeeDeliveryHealth } from "@/lib/team";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  if (!canAccessSpace(user, "firm") && !canSeeDeliveryHealth(user)) {
    return Response.json({ error: "The signal inbox is limited to the delivery lead and the sales/marketing team." }, { status: 403 });
  }
  const { signals, deIdentified } = await buildInbox(user);
  return Response.json({ signals, deIdentified });
}
