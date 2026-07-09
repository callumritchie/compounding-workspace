/* ---------------------------------------------------------------------------
   signals/assess.ts — make a surfaced insight's confidence AUDITABLE.

   The inbox scores each signal by confidence × urgency × freshness × role-match
   (see inbox.ts). This module turns that into a legible, HONEST read for the UI:
     • factors — the real drivers behind the rating (signal strength, corroboration,
       freshness, verbatim evidence, breadth), each graded strong/moderate/weak.
     • caveats — the counter-check: what would challenge or strengthen the insight,
       derived from the ACTUAL gaps in its evidence.

   Nothing here is invented. Every factor and caveat is computed from fields the
   signal already carries and the card already shows — a faithful explanation of
   the score, not a second, hallucinated opinion.
--------------------------------------------------------------------------- */

import type { InboxSignal } from "./inbox";

export type FactorStatus = "strong" | "moderate" | "weak";
export type ConfFactor = { label: string; status: FactorStatus; detail: string };
export type SignalAssessment = {
  band: "high" | "medium" | "low";
  factors: ConfFactor[];
  caveats: string[]; // empty ⇒ nothing in the evidence undercuts it
};

function ageLabel(days?: number): string {
  if (days == null) return "";
  if (days <= 0) return "today";
  if (days === 1) return "1 day old";
  if (days < 14) return `${days} days old`;
  return `${Math.round(days / 7)} weeks old`;
}

export function assessSignal(s: InboxSignal): SignalAssessment {
  const band: SignalAssessment["band"] = s.confidence >= 0.7 ? "high" : s.confidence >= 0.5 ? "medium" : "low";
  const count = s.support?.count ?? 0;
  const sectors = s.support?.sectors?.length ?? 0;
  const factors: ConfFactor[] = [];

  // 1. Extraction strength — the confidence the signal was pulled with.
  factors.push({
    label: "Signal strength",
    status: s.soft ? "weak" : s.confidence >= 0.8 ? "strong" : "moderate",
    detail: s.soft ? "below the review threshold" : `${Math.round(s.confidence * 100)}% confidence`,
  });

  // 2. Corroboration — how many engagements/sources back it.
  if (count > 0) {
    factors.push({
      label: "Corroboration",
      status: count >= 3 ? "strong" : count === 2 ? "moderate" : "weak",
      detail: `${count} engagement${count === 1 ? "" : "s"}`,
    });
  } else {
    factors.push({
      label: "Corroboration",
      status: s.evidence.length ? "moderate" : "weak",
      detail: s.evidence.length ? "single engagement" : "single source",
    });
  }

  // 3. Freshness — a real input to the score.
  if (s.ageDays != null) {
    factors.push({
      label: "Freshness",
      status: s.ageDays <= 21 ? "strong" : s.ageDays <= 60 ? "moderate" : "weak",
      detail: ageLabel(s.ageDays),
    });
  } else {
    factors.push({ label: "Freshness", status: "moderate", detail: "standing signal" });
  }

  // 4. Directness — grounded in a verbatim quote vs. inferred.
  factors.push({
    label: "Evidence",
    status: s.evidence.length ? "strong" : "weak",
    detail: s.evidence.length ? `${s.evidence.length} verbatim excerpt${s.evidence.length === 1 ? "" : "s"}` : "inferred — no quote",
  });

  // 5. Breadth — only when it spans more than one sector (aggregate signals).
  if (sectors > 1) {
    factors.push({ label: "Breadth", status: sectors >= 3 ? "strong" : "moderate", detail: `across ${sectors} sectors` });
  }

  // The counter-check: honest weaknesses that would challenge or strengthen it.
  const caveats: string[] = [];
  if (s.soft) caveats.push("Low-confidence extraction — verify against the source before acting on it.");
  if (!s.deIdentified && count <= 1) caveats.push("Rests on a single engagement; corroboration elsewhere would strengthen it.");
  if (s.ageDays != null && s.ageDays > 60) caveats.push(`Evidence is ${ageLabel(s.ageDays)} — the situation may have moved.`);
  if (s.evidence.length === 0) caveats.push("No verbatim excerpt is attached — the claim is inferred, not quoted.");
  if (s.deIdentified) caveats.push("Aggregated across multiple clients and de-identified.");

  return { band, factors, caveats };
}
