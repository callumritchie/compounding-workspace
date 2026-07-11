/* ---------------------------------------------------------------------------
   signals/clarify.ts — the system asking YOU 1–3 questions (AskUserQuestion-style).

   Some insights are one answer away from being much more certain or much more
   actionable. Rather than surface them at half-confidence, the agent asks the
   targeted question whose answer would firm it up — or kill it. Answers feed back
   as REFINEMENTS (a context/correction/nullify annotation), closing the loop.

   The TRIGGERS are deterministic (they fire only where an answer genuinely helps —
   never on a clean, high-confidence card, so this stays signal not noise). Sharper,
   bespoke phrasing from an LLM is a drop-in upgrade; these templates work with no
   model and no cost.
--------------------------------------------------------------------------- */

export type ClarifyingQuestion = { q: string; why: string };

// A structural subset of an inbox signal — avoids coupling clarify to the full type.
export type ClarifyInput = {
  id: string;
  family: string;
  confidence: number;
  client?: string;
  convergence?: { kind: string; signals: { modality: string; provenance?: string; text: string }[] };
  followOn?: { contact: { name: string } | null; client: string; move?: string };
  offer?: { staffing: { band: string }; need: string };
  proposition?: { label: string; source?: string };
};

const MAX = 3;

export function clarifyingQuestions(s: ClarifyInput): ClarifyingQuestion[] {
  const out: ClarifyingQuestion[] = [];

  // A convergence card leaning on a STALE external document — is it still true?
  const stale = s.convergence?.signals.find((m) => m.provenance && /stale/i.test(m.provenance));
  if (stale) {
    out.push({
      q: "The external input here is stale — do you have anything more recent that confirms or contradicts it?",
      why: "A key member of this convergence is old/client-supplied; fresh corroboration would firm it up (or drop it).",
    });
  }

  // A convergence built partly on an UNEVIDENCED objective — is that gap real?
  const gap = s.convergence?.signals.find((m) => /not yet evidenced/i.test(m.text));
  if (gap) {
    const obj = gap.text.replace(/^objective not yet evidenced:\s*/i, "");
    out.push({
      q: `Is "${obj}" still in scope, or has the client deprioritised it?`,
      why: "It's a signed-off objective with nothing evidencing it — the answer either turns this into real work or retires it.",
    });
  }

  // A follow-on with no named sponsor — who do we actually approach?
  if (s.family === "follow-on" && s.followOn && !s.followOn.contact) {
    out.push({
      q: `Who is the sponsor / economic buyer at ${s.followOn.client}?`,
      why: "There's a live opening but no named contact on record — a name makes this immediately actionable.",
    });
  }

  // An offer we can't cleanly staff — can we resource it?
  if (s.family === "new-service-line" && s.offer && s.offer.staffing.band !== "deliverable") {
    out.push({
      q: "Can we free or hire the capacity to deliver this within the next quarter?",
      why: "Demand and price look real, but staffing is the weak leg — this determines whether it's a live offer or a hire-first bet.",
    });
  }

  // A proposition — the make-or-break commercial question.
  if (s.family === "proposition" && s.proposition && out.length === 0) {
    out.push({
      q: "Would clients pay for this as a distinct, named offering — or do they expect it bundled into existing work?",
      why: "Willingness to pay is the assumption the whole proposition rests on; confirm it before investing in the practice.",
    });
  }

  // Fallback: a genuinely uncertain read with no sharper hook.
  if (out.length === 0 && s.confidence < 0.6) {
    out.push({
      q: "What would most raise your confidence in this — a specific data point, a person to ask, or a document to check?",
      why: "This is a moderate-confidence read; naming the missing piece turns it into a next step.",
    });
  }

  return out.slice(0, MAX);
}
