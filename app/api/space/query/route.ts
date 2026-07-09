/* POST /api/space/query  { spaceId, query, audience? }
   → a synthesised CROSS-PROJECT answer with provenance. Resolves the space to its
   projects, runs the coarse→fine→map→reduce pipeline, and de-identifies when the
   space spans multiple clients (query-time confidentiality). */

import { getSpace, resolveSpaceProjects, spaceSpansMultipleClients } from "@/lib/spaces";
import { answerAcross } from "@/lib/retrieval";
import { canAccessSpace, spaceAccessBlockReason } from "@/lib/team";
import { getDb, audit } from "@/lib/db";

export async function POST(req: Request) {
  const { spaceId, query, audience, user } = await req.json().catch(() => ({}));
  if (typeof spaceId !== "string" || typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "missing spaceId/query" }, { status: 400 });
  }
  const space = await getSpace(spaceId);
  if (!space) return Response.json({ error: "space not found" }, { status: 404 });

  // H1/F2: role-gated access to the lens (firm-wide combines every client → Lead only).
  const who = typeof user === "string" ? user : "unknown";
  if (!canAccessSpace(who, space.type)) {
    return Response.json({ error: spaceAccessBlockReason(who, space.type) }, { status: 403 });
  }

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

  // H3: cross-client confidentiality audit — who asked what of which clients' data,
  // and whether it was de-identified. Every combining-of-clients answer is logged.
  if (abstract) {
    audit(getDb(), {
      actor: who,
      action: "cross_client_query",
      scope: `space/${space.id}`,
      detail: { audience: audience ?? "consultant", abstracted: true, engagements: result.projectsUsed.length, query: query.slice(0, 200) },
    });
  }
  return Response.json({ ...result, abstracted: abstract, spanned: projectIds.length });
}
