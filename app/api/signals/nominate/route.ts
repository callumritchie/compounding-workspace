/* POST /api/signals/nominate  { insight, sectors[], user }
   → propose an emergent theme as a firm-level memory (ticket G2). It enters the
   same nomination → review → promote pipeline as any shared-memory candidate, so a
   Lead validates it before it becomes firm knowledge. Nothing auto-promotes. */

import { addNomination } from "@/lib/promotion";
import { canApprove } from "@/lib/team";

export async function POST(req: Request) {
  const { insight, sectors, user } = await req.json().catch(() => ({}));
  if (typeof insight !== "string" || !insight.trim() || typeof user !== "string") {
    return Response.json({ error: "missing insight/user" }, { status: 400 });
  }
  // A single-sector theme can target that sector; a cross-sector one goes company-wide.
  const targetScope = Array.isArray(sectors) && sectors.length === 1 ? `sector/${sectors[0]}` : "company/lessons";
  if (!canApprove(user, targetScope)) {
    return Response.json({ error: `Only a Lead can nominate into ${targetScope}.` }, { status: 403 });
  }
  const nom = await addNomination({
    fact: insight.trim(),
    targetScope,
    reason: "Emergent theme surfaced by cross-project triangulation.",
    nominatedBy: user,
    sourceProject: "(triangulation)",
    sourceClient: "(multiple)",
  });
  return Response.json({ ok: true, id: nom.id, targetScope });
}
