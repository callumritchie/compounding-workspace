/* GET /api/promotions → { nominations }  (pending review queue) */

import { listNominations } from "@/lib/promotion";

export async function GET() {
  const nominations = await listNominations("pending");
  return Response.json({ nominations });
}
