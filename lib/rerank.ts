/* ---------------------------------------------------------------------------
   rerank.ts — LLM-as-reranker.

   Vector search finds passages that are *near* the query in embedding space,
   but "near" isn't the same as "answers the question". A quick second pass asks
   the model to reorder the retrieved passages by true relevance and keep the
   best few. This is what makes semantic_search return sharp context instead of
   a rough top-k.

   Lives in its own module (not agent.ts) so lib/tools.ts can use it without an
   agent.ts ↔ tools.ts import cycle.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";

// Reranking is a lightweight relevance-scoring task — Haiku handles it well at a
// fraction of the latency/cost of the main model.
const MODEL = "claude-haiku-4-5";
const client = new Anthropic();

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Given a query and numbered passages, return the indices of the best `topN`,
// best first. Falls back to the original order if the model's reply can't be
// parsed — so retrieval degrades gracefully rather than failing.
export async function rerank(query: string, passages: string[], topN = 4): Promise<number[]> {
  if (passages.length <= topN) return passages.map((_, i) => i);
  const numbered = passages.map((p, i) => `[${i}] ${p.slice(0, 400)}`).join("\n\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 60,
    system:
      "You are a reranker. Given a query and numbered passages, return ONLY a JSON array of the passage indices most relevant to the query, best first.",
    messages: [{ role: "user", content: `Query: ${query}\n\nPassages:\n${numbered}\n\nTop ${topN} indices as JSON:` }],
  });
  try {
    const match = textOf(response).match(/\[[\d,\s]*\]/);
    const arr = match ? (JSON.parse(match[0]) as number[]) : [];
    const valid = arr.filter((i) => Number.isInteger(i) && i >= 0 && i < passages.length);
    return valid.length ? valid.slice(0, topN) : passages.map((_, i) => i).slice(0, topN);
  } catch {
    return passages.map((_, i) => i).slice(0, topN);
  }
}
