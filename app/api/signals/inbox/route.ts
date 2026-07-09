/* GET /api/signals/inbox?user= → the prioritized signal inbox across every family
   (buying / competitive / objection / churn / early-warning / delivery-health /
   risk-playbook / new-service-line).

   The inbox is open to the whole team — catching missed risks and opportunities
   shouldn't depend on job title. Access is shaped INSIDE buildInbox: each family
   is gated by VISIBILITY (only delivery-health stays lead-only, as sensitive
   internal-team candour) and cross-client reads are de-identified. */

import { buildInbox } from "@/lib/signals/inbox";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  const { signals, deIdentified } = await buildInbox(user);
  return Response.json({ signals, deIdentified });
}
