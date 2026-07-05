/* GET /api/memory/proposals → { proposals }  (suggested memories awaiting approval) */

import { listProposals } from "@/lib/proposals";

export async function GET() {
  const proposals = await listProposals();
  return Response.json({ proposals });
}
