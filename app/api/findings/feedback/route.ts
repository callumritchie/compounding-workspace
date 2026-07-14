/* POST /api/findings/feedback → record a response to an in-project finding, keyed by
   its stable id so it survives recomputation (the fix for the old no-op dismiss):
     • { response: 'dismissed', reason: 'wrong' }        → retire for the whole team
     • { response: 'dismissed', reason: 'not-relevant' } → mute for this user
     • { response: 'snoozed',  reason: 'not-now' }       → hide until snooze window ends
     • { response: 'accepted' | 'saved' }                → positive signal the ranker reinforces
   See recordFindingFeedback + suppressedFor in lib/findings.ts. */

import { recordFindingFeedback } from "@/lib/findings";
import { isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

const RESPONSES = ["accepted", "saved", "dismissed", "snoozed"] as const;
type Response4 = (typeof RESPONSES)[number];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });

  const findingId = String(body.id ?? "");
  const kind = String(body.kind ?? "");
  const project = String(body.project ?? DEFAULT_PROJECT);
  const response = (RESPONSES as readonly string[]).includes(body.response) ? (body.response as Response4) : null;
  if (!findingId || !response) return Response.json({ error: "id and response required" }, { status: 400 });

  const reason = typeof body.reason === "string" ? body.reason : undefined;
  await recordFindingFeedback({ findingId, kind, project, actor: user, response, reason });
  return Response.json({ ok: true });
}
