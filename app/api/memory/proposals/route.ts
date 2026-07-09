/* GET /api/memory/proposals?user=&project= → { proposals }
   Suggested memories awaiting approval, scoped to the current context: a
   suggestion shows when its scope is one this user/engagement inherits (via
   scopesFor) or when this user raised it — so the Pending tab never surfaces
   another engagement's in-flight suggestions. Falls back to all when no context
   is supplied (legacy callers). */

import { listProposals } from "@/lib/proposals";
import { scopesFor } from "@/lib/memory";
import { getProjectConfig } from "@/lib/project";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const user = params.get("user");
  const project = params.get("project");
  const all = await listProposals();
  if (!user || !project) return Response.json({ proposals: all });
  const visible = new Set(scopesFor(user, await getProjectConfig(project)));
  const proposals = all.filter((p) => visible.has(p.scope) || p.proposedBy === user);
  return Response.json({ proposals });
}
