/* POST /api/memory/proposals/approve { id, fact? } → save the suggested memory. */

import { approveProposal } from "@/lib/proposals";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const id = b?.id;
  if (typeof id !== "string") return Response.json({ error: "missing id" }, { status: 400 });
  const ok = await approveProposal(id, typeof b?.fact === "string" ? b.fact : undefined);
  return Response.json({ ok });
}
