/* GET /api/signals/history → insights the team has RESOLVED (left the active feed but
   never deleted). This is the record of what we flagged and closed — later the raw
   material for the decision-quality plane. */

import { listResolved } from "@/lib/signals/states";
import { getAnnotationsFor } from "@/lib/signals/annotations";

export async function GET() {
  const resolved = listResolved();
  const annotations = getAnnotationsFor(resolved.map((r) => r.signalId));
  return Response.json({ resolved, annotations });
}
