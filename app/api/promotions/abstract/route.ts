/* POST /api/promotions/abstract  { id }
   → { abstracted, leak }

   Runs the abstraction step (strip client specifics) and the confidentiality
   leak-check. Does NOT write anything — the reviewer previews/edits first.
*/

import { getNomination, leakCheck } from "@/lib/promotion";
import { abstractLesson } from "@/lib/agent";

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

  const leak = leakCheck(abstracted, [nom.sourceClient, nom.sourceProject]);
  return Response.json({ abstracted, leak });
}
