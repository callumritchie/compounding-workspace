/* POST /api/space/query  { spaceId, query, audience? }
   → a synthesised CROSS-PROJECT answer with provenance. Resolves the space to its
   projects, runs the coarse→fine→map→reduce pipeline, and de-identifies when the
   space spans multiple clients (query-time confidentiality). */

import { getSpace, resolveSpaceProjects, spaceSpansMultipleClients } from "@/lib/spaces";
import { answerAcross } from "@/lib/retrieval";

export async function POST(req: Request) {
  const { spaceId, query, audience } = await req.json().catch(() => ({}));
  if (typeof spaceId !== "string" || typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "missing spaceId/query" }, { status: 400 });
  }
  const space = await getSpace(spaceId);
  if (!space) return Response.json({ error: "space not found" }, { status: 404 });

  const projectIds = await resolveSpaceProjects(space);
  if (projectIds.length === 0) {
    return Response.json({ answer: "This space has no engagements yet.", projectsUsed: [], abstracted: false });
  }
  const abstract = await spaceSpansMultipleClients(space);
  const result = await answerAcross(
    query,
    { projectIds },
    { abstract, audience: typeof audience === "string" ? audience : undefined }
  );
  return Response.json({ ...result, abstracted: abstract, spanned: projectIds.length });
}
