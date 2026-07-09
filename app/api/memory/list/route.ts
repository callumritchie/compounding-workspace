/* GET /api/memory/list?user=&project=
   → the memories that apply to THIS user in THIS engagement, for the memory
   manager. The scope lattice is the access boundary: personal memory is only the
   current user's, project memory only the current project's, broader tiers those
   the project inherits. The glass box shows what's injected THIS turn; this shows
   the curatable library for the current context (including retracted rows).

   Falls back to the whole library only if no context is supplied (legacy callers). */

import { listAllMemories, listMemoriesForManager } from "@/lib/memory";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const user = params.get("user");
  const project = params.get("project");
  const memories = user && project ? await listMemoriesForManager(user, project) : await listAllMemories();
  return Response.json({ memories });
}
