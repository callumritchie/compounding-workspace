/* GET /api/signals/inbox?user= → the prioritized signal inbox across every family
   (buying / competitive / objection / churn / early-warning / delivery-health /
   risk-playbook / new-service-line).

   The inbox is open to the whole team — catching missed risks and opportunities
   shouldn't depend on job title. Access is shaped INSIDE buildInbox: each family
   is gated by VISIBILITY (only delivery-health stays lead-only, as sensitive
   internal-team candour) and cross-client reads are de-identified. */

import { buildInbox } from "@/lib/signals/inbox";
import { getAnnotationsFor } from "@/lib/signals/annotations";
import { assessSignal } from "@/lib/signals/assess";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  const { signals, deIdentified } = await buildInbox(user);
  // Make each insight's confidence AUDITABLE: attach a faithful read of the drivers
  // behind its rating + a counter-check, computed only from fields it already carries.
  const assessed = signals.map((s) => ({ ...s, assessment: assessSignal(s) }));
  // Attach the shared human layer: every teammate's notes on these insights, and a
  // per-signal rollup flagging any that the team has nullified. One round-trip so
  // the surfaced feed and its collective annotations always render together.
  const annotations = getAnnotationsFor(signals.map((s) => s.id));
  return Response.json({ signals: assessed, deIdentified, annotations });
}
