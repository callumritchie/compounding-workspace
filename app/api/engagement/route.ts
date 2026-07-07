/* GET /api/engagement?project=<id>
   → { summary, file } for the engagement strip, or { summary: null } when the
   project has no engagement.md. `file` is the path to open in the editor. */

import { getEngagement, engagementSummary, ENGAGEMENT_FILE } from "@/lib/engagement";

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project");
  if (!project) return Response.json({ error: "missing project" }, { status: 400 });
  const eng = await getEngagement(project);
  return Response.json({ summary: eng ? engagementSummary(eng) : null, file: ENGAGEMENT_FILE });
}
