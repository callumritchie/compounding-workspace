/* ---------------------------------------------------------------------------
   signals/inbox.ts — the prioritized signal inbox (the surface).

   Assembles every signal family into ONE feed for a user, then:
     • GATES by role — delivery-health/early-warning/risk-playbook need the delivery
       lead; the aggregate families need firm authorisation; nothing leaks to a role
       that shouldn't see it.
     • DE-IDENTIFIES the aggregate families (new-service-line, emergent, risk-playbook
       show sectors + counts, never client names); single-account signals keep the
       client for the authorised viewer and are audit-logged.
     • SCORES by urgency × freshness(age-decay) × confidence × role-match, so
       perishable signals surface and age out — this is what makes it PUSH not pull.
     • FLAGS soft signals (low-confidence transcript intel) so they route through the
       existing nomination → review gate before driving an external action.
--------------------------------------------------------------------------- */

import { getDb, audit } from "../db";
import { roleOf, canAccessSpace, canSeeDeliveryHealth } from "../team";
import { queryAtoms } from "./atoms";
import { accountHealth, riskEarlyWarnings, deliveryHealth, mitigationPlaybook } from "./temporal";
import { detectWhitespace } from "./whitespace";
import { buildOffer, type Offer } from "../offers";
import { buildFollowOns, attachFollowOnLinks, type FollowOn, type Proposition } from "../followons";
import { getDeepInsights, type TriangulatedInsight } from "../deep-insights";
import { connectedSignals } from "./connected";

export type SignalFamily =
  | "buying" | "competitive" | "objection" | "churn"
  | "early-warning" | "delivery-health" | "risk-playbook" | "new-service-line"
  // Stakeholder-value families: a named follow-on opening + a broad firm proposition.
  | "follow-on" | "proposition"
  // The latent layer: a non-obvious hypothesis triangulated across scattered signals.
  | "triangulated"
  // Connected-workspace families (demo): sourced from mocked MCP connectors, not the corpus.
  | "pipeline" | "resourcing" | "pricing";

export type SignalRoute = "sales" | "marketing" | "leadership" | "practice";

// A connected data source (mocked MCP connector). Present only on demo signals so the
// UI can label their provenance and never conflate them with corpus-derived intel.
export type ConnectedSource = "clickup" | "drive" | "pricing";

export type InboxSignal = {
  id: string;
  family: SignalFamily;
  route: SignalRoute;
  title: string;
  detail: string;
  evidence: string[];
  support?: { clients?: string[]; sectors: string[]; projects?: string[]; count: number };
  project?: string;
  client?: string; // omitted on de-identified (aggregate) families
  sector?: string;
  confidence: number;
  urgency: number;
  ts?: string; // freshness anchor
  ageDays?: number;
  score: number;
  soft: boolean; // below confidence threshold → needs review before acting
  deIdentified: boolean;
  actions: { draft: boolean; nominate: boolean }; // which in-place actions apply
  source?: ConnectedSource; // set only on connected-workspace (demo) signals
  note?: string; // plain-language gloss shown in the evidence panel (e.g. how a score is built)
  offer?: Offer; // new-service-line only: the priced, staffable Offer join (see lib/offers.ts)
  followOn?: FollowOn; // follow-on only: the named opening + adjacent move (see lib/followons.ts)
  proposition?: Proposition; // proposition only: the broad offering the firm could develop
  triangulated?: TriangulatedInsight; // triangulated only: the non-obvious cross-signal hypothesis
};

const CONF_THRESHOLD = 0.6; // below this, a transcript-derived signal is "soft"

// Who may see each family. The inbox itself is open to the whole team — its whole
// point is to catch missed risks and opportunities, and that shouldn't depend on
// job title. The ONE exception is delivery-health: it's derived from internal-team
// candour ("the team is struggling"), so surfacing it has trust implications and
// stays gated to the delivery lead. Cross-client families are already
// de-identified, so breadth there is safe.
const VISIBILITY: Record<SignalFamily, (user: string) => boolean> = {
  buying: () => true,
  competitive: () => true,
  objection: () => true,
  churn: () => true,
  "new-service-line": () => true,
  "early-warning": () => true,
  "risk-playbook": () => true,
  "delivery-health": (u) => canSeeDeliveryHealth(u), // sensitive team-candour → lead only
  // Stakeholder-value families are open to the team (follow-on is single-account,
  // proposition is de-identified aggregate — both safe to surface broadly).
  "follow-on": () => true,
  proposition: () => true,
  // Triangulated insights can synthesise from internal candour (delivery-risk atoms),
  // so — like delivery-health — they stay with the lead rather than broadcast.
  triangulated: (u) => canSeeDeliveryHealth(u),
  // Connected-workspace (demo) families ride the same open inbox as the rest.
  pipeline: () => true,
  resourcing: () => true,
  pricing: () => true,
};

const userRoute = (user: string): SignalRoute =>
  roleOf(user) === "sales" ? "sales" : roleOf(user) === "marketing" ? "marketing" : "leadership";

function freshness(ts?: string): { f: number; ageDays?: number } {
  if (!ts) return { f: 0.55 }; // timeless signals get a neutral weight
  const age = (Date.now() - new Date(ts).getTime()) / 86_400_000;
  if (!Number.isFinite(age)) return { f: 0.55 };
  return { f: 1 / (1 + Math.max(0, age) / 14), ageDays: Math.round(age) }; // ~2-week half-context
}

export async function buildInbox(user: string): Promise<{ signals: InboxSignal[]; deIdentified: boolean }> {
  const raw: InboxSignal[] = [];
  const mk = (s: Omit<InboxSignal, "score" | "ageDays">): void => {
    const { f, ageDays } = freshness(s.ts);
    const roleMatch = s.route === userRoute(user) ? 1.25 : 1;
    const score = Number((s.confidence * s.urgency * f * roleMatch).toFixed(4));
    raw.push({ ...s, ageDays, score });
  };

  // ---- Sales atoms: buying / competitive / objection (single-account, client kept) ----
  for (const a of queryAtoms({ types: ["buying", "competitive", "objection"], sourceKinds: ["client-transcript"] })) {
    const family = a.type as SignalFamily;
    const route: SignalRoute = family === "objection" ? "marketing" : "sales";
    mk({
      id: a.id, family, route,
      title: a.text,
      detail: `${a.client} · ${a.sector}`,
      evidence: [a.evidence].filter(Boolean),
      project: a.project, client: a.client, sector: a.sector,
      confidence: a.confidence, urgency: a.urgency, ts: a.ts,
      soft: a.confidence < CONF_THRESHOLD,
      deIdentified: false,
      actions: { draft: family !== "objection", nominate: true },
    });
  }

  // ---- Account churn early-warning (single-account) ----
  for (const h of await accountHealth()) {
    if (h.trend !== "declining") continue;
    mk({
      id: `churn:${h.project}`, family: "churn", route: "sales",
      title: `${h.client} sentiment is sliding (${h.slope > 0 ? "+" : ""}${h.slope} over ${h.meetings} meetings)`,
      detail: `${h.client} · ${h.sector} — churn risk on a live engagement`,
      evidence: [h.evidence].filter(Boolean),
      project: h.project, client: h.client, sector: h.sector,
      confidence: Math.min(1, 0.5 + Math.abs(h.slope) / 3), urgency: 0.9, ts: h.ts,
      soft: false, deIdentified: false,
      actions: { draft: false, nominate: false },
    });
  }

  // ---- Delivery-health (GATED — from internal candour) ----
  for (const d of await deliveryHealth()) {
    if (d.band === "healthy") continue;
    mk({
      id: `dh:${d.project}`, family: "delivery-health", route: "practice",
      title: `${d.project} delivery health: ${d.band}`,
      detail: d.drivers.join("; "),
      evidence: [d.evidence].filter(Boolean),
      project: d.project, client: d.client, sector: d.sector,
      // Confidence follows how many independent drivers agree — one driver is a hint,
      // three converging is a firm read. (No invented number: driver count is real.)
      confidence: Math.min(0.9, 0.5 + d.drivers.length * 0.15), urgency: d.band === "at-risk" ? 0.9 : 0.6,
      soft: false, deIdentified: false,
      note: `Delivery-risk index ${d.score.toFixed(2)} / 1.00 — lower is worse. Built from ${d.drivers.join(", ")}.`,
      actions: { draft: false, nominate: false },
    });
  }

  // ---- Early warning (live risk escalating, unmitigated) ----
  for (const r of await riskEarlyWarnings()) {
    mk({
      id: `ew:${r.project}`, family: "early-warning", route: "leadership",
      title: `${r.risk} — escalating & unmitigated (${r.from}→${r.to})`,
      detail: `${r.client} · ${r.sector} — ${r.weeks} weeks tracked`,
      evidence: [r.evidence],
      project: r.project, client: r.client, sector: r.sector,
      confidence: 0.85, urgency: 0.85,
      soft: false, deIdentified: false,
      actions: { draft: false, nominate: false },
    });
  }

  // ---- Risk & mitigation playbook (aggregate, de-identified: sectors only) ----
  for (const e of await mitigationPlaybook()) {
    if (!e.recommended) continue;
    const worked = e.mitigations.find((m) => m.mitigation === e.recommended);
    mk({
      id: `pb:${e.riskTheme}`, family: "risk-playbook", route: "practice",
      title: `Playbook: "${e.riskTheme}" — use "${e.recommended}"`,
      detail: `${worked?.worked ?? 0} resolved with this mitigation; other approaches stalled`,
      evidence: e.mitigations.map((m) => `"${m.mitigation}" → worked ${m.worked}, failed ${m.failed}`),
      support: { sectors: e.sectors, count: e.mitigations.reduce((n, m) => n + m.projects.length, 0) },
      // Confidence tracks the recommended mitigation's real track record: one win is a
      // lead, several is a playbook. Weakly-evidenced patterns land Medium, not High.
      confidence: Math.max(0.45, Math.min(0.9, 0.4 + (worked?.worked ?? 0) * 0.12)), urgency: 0.4,
      soft: false, deIdentified: true,
      actions: { draft: false, nominate: true },
    });
  }

  // ---- New service lines / whitespace, JOINED into a priced, staffable Offer ------
  // The whitespace demand is only the first leg. buildOffer couples it to pricing
  // comparables and the resourcing bench, so the card carries a real range, a
  // staffing read, and a weakest-link confidence — the insight no single tool holds.
  const offers: Offer[] = [];
  for (const w of await detectWhitespace()) {
    const offer = await buildOffer(w);
    offers.push(offer);
    const priced = offer.price ? ` · ~£${Math.round(offer.price.low / 1000)}k–£${Math.round(offer.price.high / 1000)}k` : "";
    mk({
      id: `ws:${w.need.slice(0, 40)}`, family: "new-service-line", route: "leadership",
      title: `Whitespace: ${w.need}`,
      detail: `${w.count} clients across ${w.sectors.join(" · ")} asking — not in our catalogue${priced}`,
      evidence: w.evidence,
      support: { sectors: w.sectors, count: w.count },
      // Confidence is the joined weakest-link read (demand × price × staffing), not
      // demand alone — an offer we can't staff or price shouldn't read as High.
      confidence: offer.confidence, urgency: 0.5,
      soft: false, deIdentified: true,
      actions: { draft: true, nominate: true },
      offer,
    });
  }

  // The latent layer (cached): delivery-theme + demand propositions, and the deep
  // triangulated hypotheses. Expensive (Opus + web) but disk-cached by signal hash.
  // Never let its failure break the feed — degrade to no latent layer.
  const deep = await getDeepInsights().catch(() => ({ triangulated: [] as TriangulatedInsight[], propositions: [] as Proposition[] }));

  // ---- Follow-on: a named opening on an existing account (single-account) --------
  // The warmest lead the firm has — a live buying signal, anchored to the sponsor
  // who voiced it and matched to the adjacent thing we already sell. A bespoke ask is
  // then LINKED to the firm-level proposition/priced offer it maps to (cross-altitude).
  const followOns = await attachFollowOnLinks(await buildFollowOns(), deep.propositions, offers);
  for (const f of followOns) {
    mk({
      id: f.id, family: "follow-on", route: "sales",
      title: f.contact ? `Follow-on at ${f.client} — ${f.contact.name} is ready to talk` : `Follow-on opening at ${f.client}`,
      detail: `${f.move}${f.contact ? ` · ${f.contact.name}, ${f.contact.role}` : " · no named sponsor on record"}`,
      evidence: [f.evidence].filter(Boolean),
      project: f.project, client: f.client, sector: f.sector,
      confidence: f.confidence, urgency: f.urgency, ts: f.ts,
      soft: f.confidence < CONF_THRESHOLD, deIdentified: false,
      actions: { draft: true, nominate: false },
      followOn: f,
    });
  }

  // ---- Proposition: a broad offering the firm could develop (de-identified) -------
  // One altitude above a single deal. Two sources: DEMAND (clients keep asking) and
  // DELIVERY (a pattern in what we keep finding across engagements — from emergent
  // themes), each worth packaging rather than chasing one project at a time.
  for (const p of deep.propositions) {
    const detail = p.source === "delivery"
      ? `Recurring across ${p.clients} of our engagements (${p.sectors.join(" · ")}) — package what we already do`
      : `${p.clients} clients across ${p.sectors.join(" · ")} show appetite — an offering the firm could develop`;
    mk({
      id: p.id, family: "proposition", route: "leadership",
      title: `Proposition: ${p.label}`,
      detail,
      evidence: p.evidence,
      support: { sectors: p.sectors, count: p.clients },
      sector: p.sectors[0],
      confidence: p.confidence, urgency: p.urgency,
      soft: false, deIdentified: true,
      actions: { draft: true, nominate: true },
      proposition: p,
    });
  }

  // ---- Triangulated: the non-obvious hypothesis (the latent layer) ----------------
  // Not a restated quote — an insight that only emerges from CONNECTING scattered
  // signals across engagements or of different kinds. Surfaced as a hypothesis to
  // investigate, carrying the exact signals it joined (the audit trail).
  for (const t of deep.triangulated) {
    mk({
      id: t.id, family: "triangulated", route: "leadership",
      title: t.insight,
      detail: t.soWhat,
      evidence: t.connected.map((c) => c.text),
      support: { sectors: t.sectors, projects: t.projects, clients: t.deIdentified ? undefined : t.clients, count: t.connected.length },
      sector: t.sectors[0],
      confidence: t.confidence, urgency: t.kind === "risk" ? 0.75 : 0.5,
      soft: false, deIdentified: t.deIdentified,
      actions: { draft: true, nominate: true },
      triangulated: t,
    });
  }

  // ---- Connected workspace (DEMO): ClickUp pipeline, Drive resourcing, pricing sheets ----
  // Mocked MCP-sourced signals that JOIN operating data to the project corpus. Labelled
  // as demo end-to-end; they ride the same scoring, gating and evidence surfaces.
  for (const seed of await connectedSignals(user)) mk(seed);

  // Gate by role, then rank by score.
  const signals = raw.filter((s) => VISIBILITY[s.family](user)).sort((a, b) => b.score - a.score);

  // Audit any cross-client, client-identifying read by a firm-authorised user.
  const identifying = signals.filter((s) => !s.deIdentified && s.client);
  if (identifying.length && canAccessSpace(user, "firm")) {
    audit(getDb(), { actor: user, action: "signal_inbox_read", scope: "firm", detail: `${identifying.length} client-identifying signals` });
  }

  return { signals, deIdentified: signals.some((s) => s.deIdentified) };
}
