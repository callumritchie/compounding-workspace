/* ---------------------------------------------------------------------------
   signals/converge.ts — the convergence engine. THE fix for "feels obvious".

   A single quote is something the consultant already heard. The value a system can
   add is CONVERGENCE: several independent signals — from different modalities (what
   the client said, what the team flagged internally, the risk register, the
   engagement's own behaviour) — that line up on the same thing. No one who was in
   just one meeting sees it; it only emerges from holding them together.

   This is deterministic (local embeddings, no LLM): unify every signal, cluster them
   PER ACCOUNT by theme, and keep only clusters where the evidence is genuinely
   MULTI-SOURCE. Scoring rewards diversity of modality/source/engagement and
   PENALISES the obvious: a lone single-source signal never becomes a convergence
   card — it stays where it was. So this only ever adds non-obvious, combined reads.
--------------------------------------------------------------------------- */

import { embed } from "../embed";
import { cosine } from "../vectors";
import { queryAtoms } from "./atoms";
import { riskEarlyWarnings } from "./temporal";
import { behavioralSignals } from "./behavioral";
import { documentSignals } from "./documents";

export type Modality = "client-voice" | "internal-voice" | "risk" | "behavioural" | "quant" | "finding" | "document";

export type UnifiedSignal = {
  id: string;
  modality: Modality;
  source: string; // the document / system it came from
  project: string;
  client: string;
  sector: string;
  theme: string; // the text we cluster + embed on
  ts?: string;
  strength: number; // 0..1 (already provenance-weighted for document signals)
  provenance?: string; // legible provenance label, e.g. "client-supplied · 3yr old · stale"
};

export type ConvergenceInsight = {
  id: string;
  client: string;
  sector: string;
  projects: string[];
  modalities: string[]; // the distinct modalities that converged
  signals: { modality: string; source: string; project: string; text: string; provenance?: string }[]; // the trail
  theme: string;
  kind: "risk" | "opportunity";
  soWhat: string;
  confidence: number; // driven by convergence, not any single signal
  urgency: number;
  ts?: string; // freshest member — so recent convergence outranks stale
};

const SIM = 0.42; // signals this close share a theme
const MODALITY_LABEL: Record<string, string> = {
  "client-voice": "client said",
  "internal-voice": "team flagged internally",
  risk: "risk register",
  behavioural: "engagement behaviour",
  quant: "quant data",
  finding: "our finding",
  document: "supplied document",
};

// Every signal the firm holds, normalised to one shape with its modality + source.
export async function gatherSignals(): Promise<UnifiedSignal[]> {
  const out: UnifiedSignal[] = [];

  for (const a of queryAtoms({})) {
    const modality: Modality =
      a.sourceKind === "internal-transcript" ? "internal-voice" : a.sourceKind === "client-transcript" ? "client-voice" : "client-voice";
    // Risk-register-derived atoms would be "risk", but those come via riskEarlyWarnings below.
    if (a.sourceKind === "risk-register") continue;
    out.push({
      id: a.id, modality, source: a.source || a.sourceKind,
      project: a.project, client: a.client, sector: a.sector,
      theme: a.text, ts: a.ts, strength: a.confidence,
    });
  }

  for (const w of await riskEarlyWarnings()) {
    out.push({
      id: `risk:${w.project}:${w.risk.slice(0, 24)}`, modality: "risk", source: "risk-register.md",
      project: w.project, client: w.client, sector: w.sector,
      theme: `${w.risk} (escalating ${w.from}→${w.to})`, strength: 0.8,
    });
  }

  for (const b of await behavioralSignals()) out.push(b);
  for (const d of await documentSignals()) out.push(d);

  return out;
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// Greedy single-link clustering within one account's signals.
function cluster(signals: UnifiedSignal[], vecs: number[][]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < signals.length; i++) {
    let placed = false;
    for (const g of groups) {
      if (g.some((j) => cosine(vecs[i], vecs[j]) >= SIM)) {
        g.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([i]);
  }
  return groups;
}

export async function accountConvergence(): Promise<ConvergenceInsight[]> {
  const all = await gatherSignals();
  if (all.length < 2) return [];

  // Group by client (convergence is about an ACCOUNT's story across its engagements).
  const byClient = new Map<string, UnifiedSignal[]>();
  for (const s of all) (byClient.get(s.client) ?? byClient.set(s.client, []).get(s.client)!).push(s);

  const out: ConvergenceInsight[] = [];
  for (const [client, signals] of byClient) {
    if (signals.length < 2) continue;
    const vecs = await embed(signals.map((s) => s.theme));
    for (const idxs of cluster(signals, vecs)) {
      const members = idxs.map((i) => signals[i]);
      const modalities = distinct(members.map((m) => m.modality));
      const sources = distinct(members.map((m) => m.source));
      const projects = distinct(members.map((m) => m.project));
      // THE GATE that kills "obvious": a convergence insight needs genuinely
      // independent corroboration — ≥2 modalities, or ≥3 sources. A lone signal, or
      // three quotes from the one transcript, never qualifies.
      if (members.length < 2) continue;
      if (modalities.length < 2 && sources.length < 3) continue;

      // Confidence is DRIVEN BY CONVERGENCE: more independent modalities/sources/
      // engagements agreeing = a firmer read than any single signal's own confidence.
      const diversity = modalities.length * 0.16 + Math.min(sources.length, 4) * 0.08 + (projects.length - 1) * 0.06;
      const avgStrength = members.reduce((s, m) => s + m.strength, 0) / members.length;
      const confidence = Number(Math.min(0.92, 0.4 + diversity) * (0.7 + 0.3 * avgStrength)).toFixed(2);

      const isRisk = modalities.includes("risk") || modalities.includes("internal-voice") || /risk|concern|slip|miss|churn|fail|struggl|escalat/i.test(members.map((m) => m.theme).join(" "));
      const rep = members.slice().sort((a, b) => b.strength - a.strength)[0];
      const modalityWord = modalities.map((m) => MODALITY_LABEL[m] ?? m).join(", ");

      out.push({
        id: `cv:${client}:${rep.theme.slice(0, 28).replace(/[^a-z0-9]+/gi, "-")}`,
        client, sector: members[0].sector,
        projects,
        modalities,
        signals: members.map((m) => ({ modality: MODALITY_LABEL[m.modality] ?? m.modality, source: m.source, project: m.project, text: m.theme, provenance: m.provenance })),
        theme: rep.theme,
        kind: isRisk ? "risk" : "opportunity",
        soWhat: isRisk
          ? `Get ahead of it: ${modalities.length} independent signals (${modalityWord}) point the same way — treat it as real before it surfaces on its own.`
          : `Act on it: the same opening shows up across ${modalityWord} — a stronger basis to move than any single mention.`,
        confidence: Number(confidence),
        urgency: isRisk ? 0.8 : 0.55,
        ts: members.map((m) => m.ts).filter(Boolean).sort().pop(),
      });
    }
  }
  // Most convergent (most independent corroboration) first.
  return out.sort((a, b) => b.modalities.length - a.modalities.length || b.confidence - a.confidence);
}
