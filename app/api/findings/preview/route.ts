/* POST /api/findings/preview { project, user, id }
   → { preview } — a cheap DRAFT starter for a finding (the "already did a bit for
   you" proof-of-value). The finding is re-derived server-side and matched by id, so
   the preview is grounded in real detected state, not a client-supplied payload.
   Cached on disk by the finding's substance. See generateFindingPreview in lib/findings. */

import { buildFindings, generateFindingPreview } from "@/lib/findings";
import { isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  const project = String(body.project ?? DEFAULT_PROJECT);
  const id = String(body.id ?? "");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  try {
    const finding = (await buildFindings(project, user)).find((f) => f.id === id);
    if (!finding) return Response.json({ preview: null });
    const preview = await generateFindingPreview(finding, project);
    return Response.json({ preview });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "preview failed";
    return Response.json({ preview: null, error: detail }, { status: 500 });
  }
}
