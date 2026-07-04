/* POST /api/feedback  { verdict: "good" | "bad", items: [{scope,id,type}] }
   → reinforces the LEARNED memories that fed the last answer.

   This is the anti-poisoning rule in action: memory strength moves on a
   CORRECTNESS signal (your thumbs up/down), never on mere use. Constitution
   memories are authoritative and are left untouched by reinforceMemory.
*/

import { reinforceMemory } from "@/lib/memory";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const verdict = body?.verdict;
  const items: Array<{ scope?: string; id?: string; type?: string }> = Array.isArray(body?.items) ? body.items : [];

  const delta = verdict === "good" ? 0.1 : verdict === "bad" ? -0.15 : 0;
  if (!delta) return Response.json({ error: "verdict must be good or bad" }, { status: 400 });

  let changed = 0;
  for (const it of items) {
    if (it?.type === "learned" && typeof it.scope === "string" && typeof it.id === "string") {
      if (await reinforceMemory(it.scope, it.id, delta)) changed++;
    }
  }
  return Response.json({ changed, delta });
}
