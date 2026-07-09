/* GET /api/home/briefing?user= → the fast half of the proactive Home briefing for
   firm-authorised roles: which sectors are dense enough to pitch (POV / offering).
   The slow half (emergent signals) comes from /api/signals/emergent. Gated because
   readiness aggregates across every client. */

import { sectorDensity } from "@/lib/cards";
import { canAccessSpace } from "@/lib/team";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  if (!canAccessSpace(user, "firm")) {
    return Response.json({ error: "The firm briefing spans every client." }, { status: 403 });
  }
  const sectors = await sectorDensity();
  return Response.json({ sectors });
}
