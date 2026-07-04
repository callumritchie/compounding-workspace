/* GET /api/files?project=acme-health → { files: string[] }  (the shared corpus) */

import { listFiles, DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project") || DEFAULT_PROJECT;
  const files = await listFiles(project);
  return Response.json({ files });
}
