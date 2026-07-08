/* GET /api/signals/emergent → emergent, triangulated themes across the firm's
   engagements (weak in one, strong across many). Lead-only: it spans all clients. */

import { detectEmergentThemes } from "@/lib/triangulate";
import { canAccessSpace } from "@/lib/team";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  if (!canAccessSpace(user, "firm")) {
    return Response.json({ error: "Triangulation spans every client — only a Lead can run it." }, { status: 403 });
  }
  const themes = await detectEmergentThemes();
  return Response.json({ themes });
}
