/* POST /api/memory/proposals/approve { user, id, fact? } → save the suggested
   memory, if this user is allowed to approve into that scope. */

import { approveProposal, getProposal } from "@/lib/proposals";
import { canApprove, approvalBlockReason } from "@/lib/team";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const id = b?.id;
  const user = b?.user;
  if (typeof id !== "string" || typeof user !== "string")
    return Response.json({ error: "missing id/user" }, { status: 400 });
  const p = await getProposal(id);
  if (!p) return Response.json({ error: "not found" }, { status: 404 });
  if (!canApprove(user, p.scope))
    return Response.json({ error: approvalBlockReason(user, p.scope) }, { status: 403 });
  const ok = await approveProposal(id, typeof b?.fact === "string" ? b.fact : undefined);
  return Response.json({ ok });
}
