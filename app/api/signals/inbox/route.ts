/* GET /api/signals/inbox?user= → the prioritized signal inbox across every family
   (buying / competitive / objection / churn / early-warning / delivery-health /
   risk-playbook / new-service-line).

   The inbox is open to the whole team — catching missed risks and opportunities
   shouldn't depend on job title. Access is shaped INSIDE buildInbox: each family
   is gated by VISIBILITY (only delivery-health stays lead-only, as sensitive
   internal-team candour) and cross-client reads are de-identified. */

import { buildInbox } from "@/lib/signals/inbox";
import { getAnnotationsFor } from "@/lib/signals/annotations";
import { assessSignal } from "@/lib/signals/assess";
import { currentStates, isHidden, isAged } from "@/lib/signals/states";
import { clarifyingQuestions } from "@/lib/signals/clarify";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user") ?? "unknown";
  const { signals, deIdentified } = await buildInbox(user);

  // The shared human layer + lifecycle, keyed by each insight's stable id.
  const states = currentStates(signals.map((s) => s.id));
  const annotations = getAnnotationsFor(signals.map((s) => s.id));

  // Lifecycle: resolved / actively-snoozed insights leave the ACTIVE feed (they live
  // in History, never deleted). Everything else stays, carrying its state + a decay
  // flag + any clarifying questions the agent wants answered.
  const assessed = signals
    .filter((s) => !isHidden(states[s.id]))
    .map((s) => {
      const st = states[s.id];
      const roll = annotations[s.id];
      return {
        ...s,
        // Make confidence AUDITABLE: the real drivers + a counter-check.
        assessment: assessSignal(s),
        // Lifecycle state (owned/reopened) so the UI can badge the owner.
        state: st ? { state: st.state, actor: st.actor, ts: st.ts } : undefined,
        // Decay: fold away stale, low-value, untouched cards — never a high-value one.
        aged: isAged({ ageDays: s.ageDays, score: s.score, confidence: s.confidence, state: st, hasNotes: !!roll?.count }),
        // 1–3 targeted questions whose answers would firm this up (or retire it).
        clarify: clarifyingQuestions(s),
      };
    });

  return Response.json({ signals: assessed, deIdentified, annotations });
}
