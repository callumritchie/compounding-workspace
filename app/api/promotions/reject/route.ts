/* POST /api/promotions/reject  { id } → marks a nomination rejected. */

import { rejectNomination } from "@/lib/promotion";

export async function POST(req: Request) {
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return Response.json({ error: "missing id" }, { status: 400 });
  const ok = await rejectNomination(id);
  return Response.json({ ok });
}
