/* POST /api/promotions/promote  { user, id, text }
   → writes the (abstracted, reviewer-approved) text to the target scope, if this
   user is allowed to promote into it (broad scopes need a Lead). */

import { promoteNomination, getNomination } from "@/lib/promotion";
import { canApprove, approvalBlockReason } from "@/lib/team";

export async function POST(req: Request) {
  const { id, text, user } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || typeof text !== "string" || !text.trim() || typeof user !== "string") {
    return Response.json({ error: "missing id/text/user" }, { status: 400 });
  }
  const nom = await getNomination(id);
  if (!nom) return Response.json({ error: "not found" }, { status: 404 });
  if (!canApprove(user, nom.targetScope))
    return Response.json({ error: approvalBlockReason(user, nom.targetScope) }, { status: 403 });
  const r = await promoteNomination(id, text.trim());
  if (!r.ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, scope: r.scope });
}
