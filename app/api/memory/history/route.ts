/* GET /api/memory/history?scope=&id=
   → the audit trail for one memory (who changed what, when), newest first. */

import { memoryHistory } from "@/lib/memory";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const id = url.searchParams.get("id");
  if (!scope || !id) return Response.json({ error: "missing scope/id" }, { status: 400 });
  const history = await memoryHistory(scope, id);
  return Response.json({ history });
}
