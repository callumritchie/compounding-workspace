/* POST /api/promotions/promote  { user, id, text }
   → writes the (abstracted, reviewer-approved) text to the target scope, if this
   user is allowed to promote into it (broad scopes need a Lead). */

import { promoteNomination, getNomination, leakCheck } from "@/lib/promotion";
import { canApprove, approvalBlockReason } from "@/lib/team";
import { leakCheckLLM } from "@/lib/agent";

export async function POST(req: Request) {
  const { id, text, user, acknowledgedLeak } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || typeof text !== "string" || !text.trim() || typeof user !== "string") {
    return Response.json({ error: "missing id/text/user" }, { status: 400 });
  }
  const nom = await getNomination(id);
  if (!nom) return Response.json({ error: "not found" }, { status: 404 });
  if (!canApprove(user, nom.targetScope))
    return Response.json({ error: approvalBlockReason(user, nom.targetScope) }, { status: 403 });

  // Confidentiality gate: re-check the FINAL (reviewer-edited) text. If it still
  // leaks and the reviewer hasn't explicitly acknowledged it, block the promote —
  // a shared-scope write must be a deliberate decision, not an accident.
  if (acknowledgedLeak !== true) {
    const substring = leakCheck(text, [nom.sourceClient, nom.sourceProject]);
    const llm = await leakCheckLLM(text, nom.sourceClient);
    if (substring.flagged || llm.flagged) {
      return Response.json(
        { error: "leak", needsAck: true, hits: substring.hits, reasons: llm.reasons },
        { status: 409 }
      );
    }
  }

  const r = await promoteNomination(id, text.trim(), user);
  if (!r.ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, scope: r.scope });
}
