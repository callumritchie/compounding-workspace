/* GET /api/signals/emergent → emergent, triangulated themes across the firm's
   engagements (weak in one, strong across many). Firm-authorised roles only
   (lead / sales / marketing) — it spans every client. */

import { detectEmergentThemes } from "@/lib/triangulate";
import { canAccessSpace } from "@/lib/team";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  if (!canAccessSpace(user, "firm")) {
    return Response.json({ error: "Triangulation spans every client — limited to Leads and the sales/marketing team." }, { status: 403 });
  }
  const themes = await detectEmergentThemes();
  return Response.json({ themes });
}
