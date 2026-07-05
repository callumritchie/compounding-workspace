/* POST /api/demo/reset → restore the guided-demo baseline (idempotent). */

import { resetDemo } from "@/lib/demo";

export async function POST() {
  await resetDemo();
  return Response.json({ ok: true });
}
