/* GET /api/projects → { projects: string[] }  (for the project switcher) */

import { listProjects } from "@/lib/corpus";

export async function GET() {
  const projects = await listProjects();
  return Response.json({ projects });
}
