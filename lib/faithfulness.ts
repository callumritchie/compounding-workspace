/* ---------------------------------------------------------------------------
   faithfulness.ts — LLM-as-judge for GROUNDING.

   A RAG system fails silently: it produces confident, fluent answers whether the
   retrieved context supported them or not. The only way to catch that is to grade
   whether each claim in an answer is actually supported by the evidence the model
   was shown. This is the RAGAS-style "faithfulness" metric (plus a citation check),
   run by a separate, capable judge model.

   Two numbers per answer:
     • faithfulness    — share of the answer's factual claims supported by EVIDENCE
                         (1.0 = fully grounded; a plausible-but-absent claim is a
                         hallucination and drags this down).
     • citationAccuracy — of any specific source / figure the answer attributes,
                         the share that actually checks out (1.0 when none to check).

   Declining to answer ("I don't have that in the files") is FAITHFUL — honesty
   about a gap is exactly what we want, not a penalty.

   Reusable beyond the eval: the same judge could gate or flag a low-faithfulness
   answer live in Interrogate (see project-rag-eval-backlog).
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const JUDGE_MODEL = "claude-opus-4-8"; // grade with a strong, separate model

export type FaithfulnessVerdict = {
  faithfulness: number; // 0..1
  citationAccuracy: number; // 0..1
  unsupported: string[]; // claims not supported by the evidence
  notes: string;
};

const SYSTEM = `You are a STRICT faithfulness judge for a retrieval-augmented (RAG) assistant. You are given a QUESTION, the ANSWER the assistant produced, and the EVIDENCE it was shown (retrieved passages + files it read).

Decide how well the ANSWER is GROUNDED in the EVIDENCE. Rules:
- A factual claim (a figure, a fact about the client/market, a quote, a named finding) must be supported by the EVIDENCE. A claim that is plausible but NOT present in the evidence is UNSUPPORTED — a hallucination.
- General reasoning, framing, hedging, or advice that does not assert a specific corpus fact is NOT a claim to check — ignore it.
- If the answer DECLINES or says the information isn't available, that is FAITHFUL (score 1.0) — do not penalise honesty about a gap.
- Judge only against the EVIDENCE provided; do not use outside knowledge.

Return STRICT JSON, no prose, exactly:
{"faithfulness": <0..1>, "citationAccuracy": <0..1>, "unsupported": ["<claim>", ...], "notes": "<one short line>"}
faithfulness = supported_claims / total_claims (1.0 if there are no factual claims).
citationAccuracy = of any specific source/figure the answer attributes, the share actually supported by the evidence (1.0 if none are attributed).`;

// Pull the first JSON object out of the model's reply (defensive against stray prose).
function parseVerdict(raw: string): FaithfulnessVerdict {
  const m = raw.match(/\{[\s\S]*\}/);
  const fallback: FaithfulnessVerdict = { faithfulness: 0, citationAccuracy: 0, unsupported: [], notes: "unparseable judge output" };
  if (!m) return fallback;
  try {
    const j = JSON.parse(m[0]);
    const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n)));
    return {
      faithfulness: clamp(j.faithfulness),
      citationAccuracy: clamp(j.citationAccuracy),
      unsupported: Array.isArray(j.unsupported) ? j.unsupported.map(String) : [],
      notes: typeof j.notes === "string" ? j.notes : "",
    };
  } catch {
    return fallback;
  }
}

export async function judgeAnswer(input: {
  question: string;
  answer: string;
  evidence: string;
}): Promise<FaithfulnessVerdict> {
  const evidence = input.evidence.trim() || "(no evidence was retrieved)";
  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `QUESTION:\n${input.question}\n\nANSWER:\n${input.answer}\n\nEVIDENCE:\n${evidence}`,
      },
    ],
  });
  const text = resp.content.find((b) => b.type === "text");
  return parseVerdict(text && text.type === "text" ? text.text : "");
}
