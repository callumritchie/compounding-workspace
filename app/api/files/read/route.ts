/* GET /api/files/read?project=acme-health&path=interviews/cfo.md → { content } */

import { readFile, DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const project = searchParams.get("project") || DEFAULT_PROJECT;
  const path = searchParams.get("path");
  if (!path) return Response.json({ error: "missing path" }, { status: 400 });

  try {
    const content = await readFile(project, path);
    return Response.json({ content });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "error";
    return Response.json({ error: detail }, { status: 400 });
  }
}
