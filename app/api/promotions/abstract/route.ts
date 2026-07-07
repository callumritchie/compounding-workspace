/* POST /api/promotions/abstract  { id }
   → { abstracted, leak }

   Runs the abstraction step (strip client specifics) and the confidentiality
   leak-check. Does NOT write anything — the reviewer previews/edits first.
*/

import { getNomination, leakCheck } from "@/lib/promotion";
import { abstractLesson, leakCheckLLM } from "@/lib/agent";

export async function POST(req: Request) {
  const { id } = await req.json().catch(() => ({}));
  const nom = await getNomination(id);
  if (!nom) return Response.json({ error: "not found" }, { status: 404 });

  const scopeLabel = nom.targetScope.split("/").slice(-1)[0] || nom.targetScope;
  let abstracted: string;
  try {
    abstracted = await abstractLesson(nom.fact, nom.sourceClient, scopeLabel);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "abstraction failed";
    return Response.json({ error: detail }, { status: 500 });
  }

  // Two-layer leak check: the cheap substring pre-filter catches literal client
  // terms; the LLM pass catches paraphrases + structural identifiers (a distinctive
  // metric, a named person, a one-of-a-kind strategy) that substring can't see.
  const substring = leakCheck(abstracted, [nom.sourceClient, nom.sourceProject]);
  const llm = await leakCheckLLM(abstracted, nom.sourceClient);
  const leak = {
    flagged: substring.flagged || llm.flagged,
    hits: substring.hits,
    reasons: llm.reasons,
  };
  return Response.json({ abstracted, leak });
}
