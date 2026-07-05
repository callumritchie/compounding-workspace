/* POST /api/promotions/reject  { user, id } → marks a nomination rejected.
   Allowed for anyone who could promote it, or the person who nominated it. */

import { rejectNomination, getNomination } from "@/lib/promotion";
import { canApprove } from "@/lib/team";

export async function POST(req: Request) {
  const { id, user } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || typeof user !== "string")
    return Response.json({ error: "missing id/user" }, { status: 400 });
  const nom = await getNomination(id);
  if (!nom) return Response.json({ error: "not found" }, { status: 404 });
  if (!canApprove(user, nom.targetScope) && user !== nom.nominatedBy)
    return Response.json({ error: "Only a Lead or the nominator can reject this." }, { status: 403 });
  const ok = await rejectNomination(id);
  return Response.json({ ok });
}
