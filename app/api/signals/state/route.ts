/* POST /api/signals/state  { user, signalId, state, note?, snoozeDays? }
   → move a surfaced insight through its lifecycle: own it, resolve it (→ History,
   never deleted), snooze it, or reopen it. Shared across the team. */

import { setSignalState, type SignalState } from "@/lib/signals/states";
import { isUser } from "@/lib/workspace";

const STATES: SignalState[] = ["owned", "resolved", "snoozed", "reopened"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = body?.user;
  const signalId = typeof body?.signalId === "string" ? body.signalId.trim() : "";
  const state = STATES.includes(body?.state) ? (body.state as SignalState) : null;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : undefined;
  const snoozeDays = typeof body?.snoozeDays === "number" ? body.snoozeDays : undefined;

  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!signalId) return Response.json({ error: "missing signalId" }, { status: 400 });
  if (!state) return Response.json({ error: "invalid state" }, { status: 400 });

  const current = setSignalState({ signalId, actor: user, state, note, snoozeDays });
  return Response.json({ ok: true, state: current });
}
