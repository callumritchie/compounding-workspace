/* ---------------------------------------------------------------------------
   drafts.ts — turn an emergent signal into a first-draft ARTIFACT in place.

   The briefing surfaces signals; this closes the loop so an intelligence user
   goes from SEEING a pattern to HAVING the thing they'd make from it — without
   leaving Home. The artifact's format follows the signal's route:
     marketing  → a publishable point-of-view piece
     sales      → a follow-on / BD pitch outline
     leadership → a leadership brief
     practice   → a delivery practice note (a standard to codify)

   Grounded in the signal's insight, recommended action, and the (already
   de-identified) evidence that clustered. Cross-client, so NO client names.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

export type SignalDraft = { title: string; kind: string; body: string };

type DraftInput = {
  insight: string;
  route: string; // leadership | marketing | sales | practice
  action: string;
  sectors: string[];
  count: number; // engagements supporting the signal
  evidence: string[]; // the raw clustered findings (already client-anonymised)
};

// The artifact to make, and how to shape it, per route.
function briefFor(route: string): { kind: string; instruction: string } {
  if (route === "marketing")
    return {
      kind: "Point of view",
      instruction:
        "Draft a publishable POV article (a piece of thought leadership). Give it a compelling title, a sharp opening that states the counter-intuitive pattern, 3–4 short sections making the argument with the cross-engagement evidence as proof, and a closing that positions the firm as the one that sees this. Confident, specific, publishable prose.",
    };
  if (route === "sales")
    return {
      kind: "Pitch outline",
      instruction:
        "Draft a follow-on / BD pitch OUTLINE aimed at a prospect facing this pattern. Structure: the pattern we keep seeing → why it costs the buyer → the proof (across N engagements, de-identified) → the offer we'd make → the suggested next step / meeting ask. Crisp bullets a salesperson could take into a conversation.",
    };
  if (route === "leadership")
    return {
      kind: "Leadership brief",
      instruction:
        "Draft a one-page leadership brief. Structure: the emergent pattern (one paragraph) → why it matters to the firm now → the implication / risk if ignored → a recommended firm action with a clear owner. Direct, decision-oriented.",
    };
  return {
    kind: "Practice note",
    instruction:
      "Draft a delivery PRACTICE NOTE that codifies this pattern into a standard the team should apply. Structure: the principle (one line) → why it holds (the cross-engagement evidence) → what to do on every relevant engagement (a short checklist) → how to spot when it applies. Practical, reusable.",
  };
}

export async function draftFromSignal(input: DraftInput): Promise<SignalDraft> {
  const { kind, instruction } = briefFor(input.route);
  const evidence = input.evidence.length ? input.evidence.join("\n") : `- ${input.insight}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    system:
      `You are a consulting firm's ${input.route} lead. ${instruction}\n\n` +
      "Ground it strictly in the evidence provided — this is a real internal artifact, not marketing fluff. " +
      "It spans multiple clients, so NEVER name a client; refer to 'our engagements', 'across our healthcare work', etc. " +
      "Return STRICT JSON: {\"title\":string,\"body\":string}. body is Markdown. No preamble, JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Emergent signal (seen across ${input.count} engagements${input.sectors.length ? `, sectors: ${input.sectors.join(", ")}` : ""}):\n` +
          `${input.insight}\n\nRecommended action: ${input.action}\n\nEvidence (client-anonymised findings that clustered):\n${evidence}\n\nJSON:`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  const raw = text && text.type === "text" ? text.text : "";
  let parsed: { title?: string; body?: string } = {};
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    // Fall back to treating the whole response as the body.
    parsed = { title: `${kind}: ${input.insight.slice(0, 60)}`, body: raw };
  }
  return {
    title: String(parsed.title ?? `${kind}`),
    kind,
    body: String(parsed.body ?? ""),
  };
}
