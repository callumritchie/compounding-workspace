/* POST /api/signals/annotate  { user, signalId, kind, body }
   → leave a shared, natural-language note on a surfaced insight: extra context, a
   correction, or a nullification. Notes are visible to the WHOLE team (the inbox is
   a shared read), so this is how the firm collectively sharpens or retires what the
   system surfaces. Returns the new note + the insight's updated rollup. */

import { addAnnotation, rollupFor, type AnnotationKind } from "@/lib/signals/annotations";
import { isUser } from "@/lib/workspace";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = body?.user;
  const signalId = typeof body?.signalId === "string" ? body.signalId.trim() : "";
  const note = typeof body?.body === "string" ? body.body.trim() : "";
  const kind: AnnotationKind =
    body?.kind === "correction" ? "correction" : body?.kind === "nullify" ? "nullify" : body?.kind === "comment" ? "comment" : "context";

  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!signalId) return Response.json({ error: "missing signalId" }, { status: 400 });
  if (!note) return Response.json({ error: "empty note" }, { status: 400 });
  if (note.length > 1000) return Response.json({ error: "note too long" }, { status: 400 });

  const annotation = addAnnotation({ signalId, author: user, kind, body: note });
  const rollup = rollupFor(signalId);
  return Response.json({ ok: true, annotation, rollup });
}
