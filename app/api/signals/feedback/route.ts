/* POST /api/signals/feedback → record whether a surfaced signal was helpful.
   The inbox's job is to catch missed risks and opportunities; telling it which
   signals were worth surfacing is how it earns trust and can learn to rank better.
   Open to the whole team (like the inbox itself). Persisted to the audit log so
   scoring (lib/signals/inbox.ts) can read it as a future input; at minimum it's a
   durable record of what people found useful. */

import { getDb, audit } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  const id = String(body.id ?? "");
  const family = String(body.family ?? "");
  const reaction = body.reaction === "helpful" ? "helpful" : body.reaction === "not-useful" ? "not-useful" : null;
  if (!id || !reaction) return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  audit(getDb(), { actor: user, action: "signal_feedback", scope: "signal", detail: { id, family, reaction } });
  return Response.json({ ok: true });
}
