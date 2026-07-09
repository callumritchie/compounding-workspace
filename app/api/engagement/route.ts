/* GET /api/engagement?project=<id>
   → { summary, file, objectives, objectivesFile } for the engagement + objectives
   strips, or nulls when the project has no engagement.md / objectives.md. `file`
   and `objectivesFile` are the paths to open in the editor. */

import { getEngagement, engagementSummary, ENGAGEMENT_FILE } from "@/lib/engagement";
import { getObjectives, OBJECTIVES_FILE } from "@/lib/objectives";

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project");
  if (!project) return Response.json({ error: "missing project" }, { status: 400 });
  const eng = await getEngagement(project);
  const objectives = await getObjectives(project);
  return Response.json({
    summary: eng ? engagementSummary(eng) : null,
    file: ENGAGEMENT_FILE,
    objectives: objectives ?? null,
    objectivesFile: OBJECTIVES_FILE,
  });
}
