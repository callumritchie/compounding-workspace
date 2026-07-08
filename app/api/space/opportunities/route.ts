/* POST /api/space/opportunities  { spaceId }
   → proactively spotted, structured opportunities across the space's engagements
   (follow-on for accounts; offerings / POVs / BD plays for sector & firm). */

import { getSpace } from "@/lib/spaces";
import { spotOpportunities } from "@/lib/opportunities";
import { canAccessSpace, spaceAccessBlockReason } from "@/lib/team";

export async function POST(req: Request) {
  const { spaceId, user } = await req.json().catch(() => ({}));
  if (typeof spaceId !== "string") return Response.json({ error: "missing spaceId" }, { status: 400 });
  const space = await getSpace(spaceId);
  if (!space) return Response.json({ error: "space not found" }, { status: 404 });
  const who = typeof user === "string" ? user : "unknown";
  if (!canAccessSpace(who, space.type)) {
    return Response.json({ error: spaceAccessBlockReason(who, space.type) }, { status: 403 });
  }
  const result = await spotOpportunities(space);
  return Response.json(result);
}
