/* GET /api/projects → { projects: ProjectConfig[] }
   Full config per project so the switcher can group by client and show status. */

import { listProjectConfigs } from "@/lib/project";

export async function GET() {
  const projects = await listProjectConfigs();
  return Response.json({ projects });
}
