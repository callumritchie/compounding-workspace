/* GET /api/memory/lifecycle → stale + near-duplicate memories to consider tidying. */

import { computeLifecycle } from "@/lib/lifecycle";

export async function GET() {
  const result = await computeLifecycle();
  return Response.json(result);
}
