/* GET /api/spaces → the lenses (account / sector / firm) the user can query
   across projects, each with the number of engagements it currently spans. */

import { listSpaces, resolveSpaceProjects } from "@/lib/spaces";

export async function GET() {
  const spaces = await listSpaces();
  const withCounts = await Promise.all(
    spaces.map(async (s) => ({ id: s.id, name: s.name, type: s.type, projects: (await resolveSpaceProjects(s)).length }))
  );
  return Response.json({ spaces: withCounts });
}
