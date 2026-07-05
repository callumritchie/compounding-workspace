/* POST /api/compare  { question, project }
   → runs ONE question through three retrieval strategies so you can compare:

     1. naïve vector   — top-k similar chunks, answer straight from them
     2. reranked vector — top-k, then an LLM reranks to the best few, then answer
     3. agentic        — the agent navigates the files itself with tools

   Each returns the context it used + its answer, so the difference is visible.
   (Agentic runs WITHOUT memory here, to isolate the retrieval strategy.)
*/

import { search } from "@/lib/vectors";
import { respond, rerank, answerFromContext } from "@/lib/agent";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function POST(req: Request) {
  const { question, project } = await req.json().catch(() => ({}));
  const proj = typeof project === "string" ? project : DEFAULT_PROJECT;
  if (typeof question !== "string" || !question.trim()) {
    return Response.json({ error: "missing question" }, { status: 400 });
  }
  const q = question.trim();

  try {
    // 1. Naïve vector: top-3 chunks → answer from exactly those.
    const naiveHits = await search(q, proj, 3);
    const naiveCtx = naiveHits.map((h) => `(${h.file}) ${h.text}`).join("\n---\n");
    const naiveAnswer = naiveHits.length
      ? await answerFromContext(q, naiveCtx)
      : "(vector index is empty — run `npm run index`)";

    // 2. Reranked vector: cast a wider net (top-8), let an LLM pick the best 3.
    const pool = await search(q, proj, 8);
    const order = pool.length ? await rerank(q, pool.map((h) => h.text), 3) : [];
    const rerankedHits = order.map((i) => pool[i]);
    const rerankedCtx = rerankedHits.map((h) => `(${h.file}) ${h.text}`).join("\n---\n");
    const rerankedAnswer = rerankedHits.length ? await answerFromContext(q, rerankedCtx) : naiveAnswer;

    // 3. Agentic: the agent decides what to open (no memory, to isolate retrieval).
    const { text: agenticAnswer, trace } = await respond([{ role: "user", content: q }], {
      projectId: proj,
      user: "callum",
    });

    return Response.json({
      naive: { chunks: naiveHits, answer: naiveAnswer },
      reranked: { chunks: rerankedHits, answer: rerankedAnswer },
      agentic: { answer: agenticAnswer, trace },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "compare failed";
    return Response.json({ error: detail }, { status: 500 });
  }
}
