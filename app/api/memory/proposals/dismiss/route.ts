/* POST /api/memory/proposals/dismiss { user, id } → discard a suggested memory.
   Allowed for anyone who could approve it, or the person who proposed it. */

import { dismissProposal, getProposal } from "@/lib/proposals";
import { canApprove } from "@/lib/team";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const id = b?.id;
  const user = b?.user;
  if (typeof id !== "string" || typeof user !== "string")
    return Response.json({ error: "missing id/user" }, { status: 400 });
  const p = await getProposal(id);
  if (!p) return Response.json({ error: "not found" }, { status: 404 });
  if (!canApprove(user, p.scope) && user !== p.proposedBy)
    return Response.json({ error: "Only a Lead or the person who suggested it can dismiss this." }, { status: 403 });
  const ok = await dismissProposal(id);
  return Response.json({ ok });
}
