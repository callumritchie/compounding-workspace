/* ---------------------------------------------------------------------------
   deep-insights.ts — the LATENT layer: value that no single signal states and no
   one who worked a single engagement could see. Three things the obvious feed can't:

     1. deliveryThemePropositions — propositions sourced from what the firm KNOWS,
        not what clients ask: recurring DELIVERY findings across engagements
        (reuses detectEmergentThemes), packaged as an offering.

     2. deepTriangulate — the hard one. Opus connects SCATTERED signals (atoms +
        risk trends) into non-obvious hypotheses: a cause, risk, or opening that
        emerges only from joining signals across engagements or of different kinds —
        the opposite of restating one quote the consultant already caught.

     3. web enrichment — external market context (trend / sector / client-org),
        clearly labelled, on the top items.

   HONESTY GATE (the whole point — a "triangulation" is worthless if it's an LLM
   hunch). Every insight must: cite signals that ACTUALLY EXIST in the input
   (fabricated refs are dropped); connect ≥2 signals from ≥2 engagements OR ≥2 types
   (a real triangulation, not a paraphrase); carry a convergence-capped confidence;
   and be framed as a HYPOTHESIS TO INVESTIGATE, with the connected-signal trail
   shown so it's auditable, never magic. Cross-client insights are de-identified.

   The expensive work (Opus + web) is disk-cached by a hash of the signal set, so the
   hot inbox path stays fast; it recomputes only when the signals change.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { queryAtoms } from "./signals/atoms";
import { riskEarlyWarnings } from "./signals/temporal";
import { detectEmergentThemes } from "./triangulate";
import { buildPropositions, type Proposition } from "./followons";
import { enrichWithWeb } from "./enrich-web";

const client = new Anthropic();
const MODEL = "claude-opus-4-8"; // cross-engagement reasoning is the hard part — use the strong model
const CACHE = path.join(process.cwd(), "workspace", "signals", "deep.json");

export type ConnectedSignal = { ref: string; type: string; project: string; sector: string; text: string };
export type TriangulatedInsight = {
  id: string;
  insight: string; // the non-obvious claim
  why: string; // how connecting the signals produces it
  soWhat: string; // the opportunity / action it implies
  kind: "risk" | "opportunity" | "positioning" | "delivery";
  connected: ConnectedSignal[]; // the exact signals it triangulated — the audit trail
  projects: string[];
  clients: string[];
  sectors: string[];
  confidence: number; // convergence-capped; an inferred hypothesis, not a fact
  deIdentified: boolean;
  webContext?: string; // optional 🌐 external enrichment
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}
function parseJson<T>(raw: string, fb: T): T {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fb;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return fb;
  }
}

const TRIANGULATE_SYSTEM = `You are a senior consulting analyst doing CROSS-ENGAGEMENT triangulation for a firm. You are given a set of signals, each already clear to the consultant who heard it on its own engagement.

Your job is the OPPOSITE of restating them. Surface only NON-OBVIOUS insights that emerge when you CONNECT signals that live in DIFFERENT engagements, or are DIFFERENT in kind — a cause, risk, pattern, or opening that NO single signal states and that nobody who only worked one engagement could see. The value is the CONNECTION.

Hard rules:
- Each insight MUST connect at least 2 signals, from at least 2 different engagements OR of at least 2 different types.
- NEVER output an insight that just paraphrases one signal, or that a consultant on that one engagement would already have said.
- These are HYPOTHESES to investigate, not established facts. Frame the insight accordingly.
- Cite the exact signal refs (e.g. "S3", "R1") you connected. Only cite refs that appear in the input.

Return STRICT JSON, no prose:
{"insights":[{"insight":string,"why":string,"soWhat":string,"kind":"risk"|"opportunity"|"positioning"|"delivery","refs":[string],"confidence":number}]}
- insight = the non-obvious claim, one sharp sentence, phrased as a hypothesis ("It looks like…", "The pattern suggests…").
- why = one sentence on HOW joining the cited signals produces it.
- soWhat = the concrete opportunity or move it implies.
- confidence = 0..1, how strongly the cited signals converge (be conservative).
Prefer 2–4 genuinely non-obvious insights over many shallow ones. JSON only.`;

// The scattered signal surface: every atom + every live risk trend, each with a
// stable ref the model must cite (so we can verify it didn't invent the connection).
export async function deepTriangulate(opts?: { max?: number }): Promise<TriangulatedInsight[]> {
  const atoms = queryAtoms({});
  if (atoms.length < 3) return [];

  const byRef = new Map<string, { type: string; project: string; client: string; sector: string; text: string }>();
  const lines: string[] = [];
  atoms.forEach((a, i) => {
    const ref = `S${i + 1}`;
    byRef.set(ref, { type: String(a.type), project: a.project, client: a.client, sector: a.sector, text: a.text });
    lines.push(`${ref} | ${a.type} | ${a.client}/${a.project} (${a.sector}) | ${a.text}${a.evidence ? ` — "${a.evidence.slice(0, 140)}"` : ""}`);
  });
  const warns = await riskEarlyWarnings();
  warns.forEach((w, i) => {
    const ref = `R${i + 1}`;
    byRef.set(ref, { type: "risk-trend", project: w.project, client: w.client, sector: w.sector, text: `${w.risk} escalating ${w.from}→${w.to}` });
    lines.push(`${ref} | risk-trend | ${w.client}/${w.project} (${w.sector}) | ${w.risk} escalating ${w.from}→${w.to} over ${w.weeks}w, unmitigated`);
  });

  let rawInsights: Record<string, unknown>[] = [];
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: TRIANGULATE_SYSTEM,
      messages: [{ role: "user", content: `Signals:\n${lines.join("\n")}\n\nJSON:` }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const parsed = parseJson<{ insights?: Record<string, unknown>[] }>(text, {});
    rawInsights = Array.isArray(parsed.insights) ? parsed.insights : [];
  } catch {
    return []; // LLM unavailable (no key / no credits / error) → no triangulation; the rest of the feed is unaffected
  }

  const out: TriangulatedInsight[] = [];
  for (const it of rawInsights) {
    const refs = Array.isArray(it.refs) ? (it.refs as unknown[]).map(String) : [];
    // Anti-hallucination: keep only refs that exist in the input we handed the model.
    const connected: ConnectedSignal[] = [];
    for (const r of refs) {
      const s = byRef.get(r);
      if (!s) continue;
      connected.push({ ref: r, type: s.type, project: s.project, sector: s.sector, text: s.text });
    }
    const projects = [...new Set(connected.map((c) => c.project))];
    const types = [...new Set(connected.map((c) => c.type))];
    // A real triangulation joins ≥2 signals across ≥2 engagements OR ≥2 types.
    if (connected.length < 2 || (projects.length < 2 && types.length < 2)) continue;

    // Distinct clients (for de-identification) — resolve each project to its client.
    const distinctClients = [...new Set(connected.map((c) => atoms.find((a) => a.project === c.project)?.client ?? c.project))];
    const sectors = [...new Set(connected.map((c) => c.sector))];

    // Confidence is capped by CONVERGENCE — more independent signals / engagements =
    // a firmer pattern — and never exceeds the model's own (conservative) read.
    const convergence = Math.min(0.85, 0.4 + connected.length * 0.1 + (projects.length - 1) * 0.05);
    const modelConf = typeof it.confidence === "number" ? Math.max(0, Math.min(1, it.confidence)) : 0.6;
    const confidence = Number(Math.min(convergence, modelConf).toFixed(2));

    out.push({
      id: `tri:${slug(String(it.insight ?? "")).slice(0, 40)}`,
      insight: String(it.insight ?? ""),
      why: String(it.why ?? ""),
      soWhat: String(it.soWhat ?? ""),
      kind: (["risk", "opportunity", "positioning", "delivery"] as const).includes(it.kind as never) ? (it.kind as TriangulatedInsight["kind"]) : "opportunity",
      connected,
      projects,
      clients: distinctClients,
      sectors,
      confidence,
      deIdentified: distinctClients.length > 1,
    });
  }
  return out.sort((a, b) => b.connected.length - a.connected.length || b.confidence - a.confidence).slice(0, opts?.max ?? 4);
}

// Propositions from DELIVERY themes — what the firm keeps finding across engagements,
// packaged as an offering (distinct from demand-driven propositions).
export async function deliveryThemePropositions(): Promise<Proposition[]> {
  const themes = await detectEmergentThemes().catch(() => []); // LLM synthesis → degrade to none
  return themes.map((t) => ({
    id: `dprop:${slug(t.insight).slice(0, 40)}`,
    theme: t.insight,
    label: t.insight,
    clients: t.support.clients.length,
    sectors: t.support.sectors,
    evidence: t.evidence,
    confidence: Number(Math.min(0.85, 0.45 + t.support.count * 0.1).toFixed(2)),
    urgency: 0.4,
    stressTest: ["A recurring pattern in our delivery — pressure-test that clients would BUY it as a distinct offering before productising."],
    source: "delivery" as const,
    soWhat: t.action,
  }));
}

// Orchestrate + cache. Merges demand + delivery propositions, runs deep triangulation,
// web-enriches the top of each, and caches by a hash of the signal set.
export async function getDeepInsights(): Promise<{ triangulated: TriangulatedInsight[]; propositions: Proposition[] }> {
  const atoms = queryAtoms({});
  const key = createHash("sha1").update(atoms.map((a) => `${a.id}:${a.text}`).sort().join("|")).digest("hex");

  try {
    const cached = JSON.parse(await fs.readFile(CACHE, "utf8")) as { key: string; triangulated: TriangulatedInsight[]; propositions: Proposition[] };
    if (cached.key === key) return { triangulated: cached.triangulated, propositions: cached.propositions };
  } catch {
    /* no cache / stale */
  }

  // Demand propositions are DETERMINISTIC (no LLM) — they must survive even when the
  // model layer is down. The triangulation + delivery themes degrade to empty on
  // failure, so a missing key / exhausted credits never breaks the feed; it just
  // loses the latent layer.
  const [triangulated, demand, delivery] = await Promise.all([deepTriangulate(), buildPropositions().catch(() => [] as Proposition[]), deliveryThemePropositions()]);
  const propositions = [...demand.map((p) => ({ ...p, source: p.source ?? ("demand" as const) })), ...delivery].sort((a, b) => b.confidence - a.confidence);

  // Web-enrich the top of each surface (bounded — one call each; enrichWithWeb already
  // degrades to null on failure) so external context rides the highest-value items.
  if (triangulated[0]) {
    triangulated[0].webContext =
      (await enrichWithWeb(triangulated[0].insight, triangulated[0].sectors[0] ?? "", "market trends, sector shifts, or client-organisation context that bear on this hypothesis")) ?? undefined;
  }
  if (propositions[0]) {
    propositions[0].webContext = (await enrichWithWeb(propositions[0].label, propositions[0].sectors[0] ?? "")) ?? undefined;
  }

  // Only cache a genuinely-computed latent layer — never persist a degraded (LLM-down)
  // result as if valid, so it recomputes once the model is reachable again.
  if (triangulated.length || delivery.length) {
    await fs.writeFile(CACHE, JSON.stringify({ key, triangulated, propositions }, null, 2)).catch(() => {});
  }
  return { triangulated, propositions };
}
