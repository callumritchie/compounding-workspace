/* POST /api/memory/proposals/dismiss { id } → discard a suggested memory. */

import { dismissProposal } from "@/lib/proposals";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const id = b?.id;
  if (typeof id !== "string") return Response.json({ error: "missing id" }, { status: 400 });
  const ok = await dismissProposal(id);
  return Response.json({ ok });
}
