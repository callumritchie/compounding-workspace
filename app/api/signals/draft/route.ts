/* POST /api/signals/draft → turn an emergent signal into a first-draft artifact
   (POV / pitch outline / leadership brief / practice note), shaped by its route.
   Firm-authorised roles only — it draws on every client's work (de-identified). */

import { draftFromSignal } from "@/lib/drafts";
import { canAccessSpace } from "@/lib/team";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!canAccessSpace(user, "firm")) {
    return Response.json({ error: "Drafting from firm signals is limited to Leads and the sales/marketing team." }, { status: 403 });
  }
  if (!body.insight) return Response.json({ error: "missing signal" }, { status: 400 });

  const draft = await draftFromSignal({
    insight: String(body.insight),
    route: String(body.route ?? "practice"),
    action: String(body.action ?? ""),
    sectors: Array.isArray(body.sectors) ? body.sectors.map(String) : [],
    count: Number(body.count ?? 0),
    evidence: Array.isArray(body.evidence) ? body.evidence.map(String) : [],
  });
  return Response.json({ draft });
}
