/* POST /api/promotions/promote  { id, text }
   → writes the (abstracted, reviewer-approved) text to the target scope. */

import { promoteNomination } from "@/lib/promotion";

export async function POST(req: Request) {
  const { id, text } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || typeof text !== "string" || !text.trim()) {
    return Response.json({ error: "missing id/text" }, { status: 400 });
  }
  const r = await promoteNomination(id, text.trim());
  if (!r.ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, scope: r.scope });
}
