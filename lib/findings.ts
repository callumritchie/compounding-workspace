/* ---------------------------------------------------------------------------
   findings.ts — the in-project proactive surface, done with the Signal Inbox's
   discipline instead of a generative guess.

   The old in-project nudge (inferNextActions' `offer`) asked a model to INVENT
   "the single most useful thing" — no provenance, no measured confidence, nothing
   to prove its value before you clicked. So people dismissed it on reflex.

   A FINDING is the opposite: a DETECTED, evidence-anchored observation about THIS
   engagement, computed from its own state. Deterministic-first (no LLM in the hot
   path) — the atoms already carry the words; we just read them honestly:

     • rising-risk         — a live risk escalating & unmitigated (from the register)
     • unanswered-objective — a signed-off objective the corpus doesn't yet address

   Each finding carries verbatim evidence + provenance, an auditable confidence read
   (assessFinding, mirroring signals/assess.ts), and a "why now" trigger. Findings
   are recomputed on demand, so — like signal annotations — feedback is keyed by a
   STABLE id and read back here (suppressedFor): a dismiss actually sticks, and the
   surface can LEARN. Silence when nothing clears the bar is the point.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { getDb } from "./db";
import { getProjectConfig } from "./project";
import { getObjectives } from "./objectives";
import { riskEarlyWarnings } from "./signals/temporal";
import { topSimilarity } from "./vectors";

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5"; // a preview is a cheap starter draft — Haiku is plenty

export type FindingKind =
  | "rising-risk"
  | "unanswered-objective"
  | "ungrounded-claim" // reserved — written by the chat route (faithfulness judge), Phase 3
  | "contradiction"; // reserved — upload-time LLM pass, Phase 3

export type FindingEvidence = { quote: string; source: string };

export type FactorStatus = "strong" | "moderate" | "weak";
export type FindingFactor = { label: string; status: FactorStatus; detail: string };
export type FindingAssessment = {
  band: "high" | "medium" | "low";
  factors: FindingFactor[];
  caveats: string[];
};

export type ProjectFinding = {
  id: string; // stable, deterministic (kind + anchors) so feedback survives recompute
  project: string;
  kind: FindingKind;
  title: string; // one sharp sentence
  detail: string; // one plain line of context
  evidence: FindingEvidence[]; // verbatim quote + provenance (document · section)
  confidence: number; // 0..1 — deterministic where possible
  urgency: number; // 0..1 — how time-sensitive
  trigger: string; // "why now" — what in the state surfaced this
  score: number; // ranking = confidence × urgency × freshness
  action?: { title: string; prompt: string }; // the deeper move, if wanted
  assessment: FindingAssessment;
};

// Only surface a finding whose confidence clears this bar — silence beats noise.
const MATERIALITY = 0.55;
// After this many "not relevant" dismissals of a KIND, the user has told us clearly
// enough — mute the whole class for them (and record why, legibly, in memory).
const MUTE_AFTER = 3;
// Below this RAW cosine similarity, nothing in the files comes close to an objective.
// Calibrated on real data: on-topic objectives land 0.50–0.83, off-topic ~0.15–0.22,
// so 0.40 separates a genuine gap from covered work with margin (see topSimilarity).
const OBJECTIVE_COVERED = 0.4;
const MAX_FINDINGS = 3;

// A slug for stable ids — same shape a human could read in the DB.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/* ---- Feedback read: what this user (or the whole team) has retired ----------
   Mirrors how signal_annotations 'nullify' survives recomputation. Keyed by the
   finding's stable id, so a dismiss made last week still suppresses it today. */
type FeedbackRow = { finding_id: string; actor: string; response: string; reason: string | null; snooze_until: string | null };

function suppressedFor(project: string, user: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT finding_id, actor, response, reason, snooze_until FROM finding_feedback WHERE project = ?")
    .all(project) as FeedbackRow[];
  const now = Date.now();
  const hidden = new Set<string>();
  for (const r of rows) {
    // 'wrong' retires the finding for everyone — it's factually off, not a taste call.
    if (r.response === "dismissed" && r.reason === "wrong") hidden.add(r.finding_id);
    // Everything else is per-user: their dismiss, their accept, their snooze window.
    if (r.actor !== user) continue;
    if (r.response === "dismissed" || r.response === "accepted" || r.response === "saved") hidden.add(r.finding_id);
    if (r.response === "snoozed") {
      const until = r.snooze_until ? new Date(r.snooze_until).getTime() : Infinity;
      if (!Number.isFinite(until) || until > now) hidden.add(r.finding_id);
    }
  }
  return hidden;
}

// Persist a response to a finding. Called by /api/findings/feedback. Async because
// crossing the mute threshold writes a legible learned memory (embedding is local).
export async function recordFindingFeedback(input: {
  findingId: string;
  kind: string;
  project: string;
  actor: string;
  response: "accepted" | "saved" | "dismissed" | "snoozed";
  reason?: string;
  snoozeDays?: number;
}): Promise<void> {
  const snoozeUntil =
    input.response === "snoozed"
      ? new Date(Date.now() + (input.snoozeDays ?? 7) * 86_400_000).toISOString()
      : null;
  getDb()
    .prepare(
      "INSERT INTO finding_feedback (finding_id, kind, project, actor, response, reason, snooze_until, ts) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(input.findingId, input.kind, input.project, input.actor, input.response, input.reason ?? null, snoozeUntil, new Date().toISOString());

  // Compounding: when "not relevant" dismissals of a kind cross the threshold, record
  // the muting as a durable PERSONAL memory — so the reason the surface went quiet is
  // legible in the Memory manager, not just implicit in a feedback table.
  if (input.response === "dismissed" && input.reason === "not-relevant") {
    const n = notRelevantCount(input.project, input.actor, input.kind);
    if (n === MUTE_AFTER) await writeMuteMemory(input.project, input.actor, input.kind).catch(() => {});
  }
}

// How many times this user has dismissed a KIND as "not relevant" on this project.
function notRelevantCount(project: string, user: string, kind: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM finding_feedback WHERE project = ? AND actor = ? AND kind = ? AND response = 'dismissed' AND reason = 'not-relevant'"
    )
    .get(project, user, kind) as { n: number };
  return row.n;
}

const KIND_LABEL: Record<string, string> = {
  "rising-risk": "escalating-risk",
  "unanswered-objective": "unanswered-objective",
  "ungrounded-claim": "ungrounded-claim",
  contradiction: "contradiction",
};

async function writeMuteMemory(project: string, user: string, kind: string): Promise<void> {
  const { writeMemory } = await import("./memory");
  const cfg = await getProjectConfig(project);
  await writeMemory({
    scope: `personal/${user}`,
    type: "learned",
    body: `${user} has repeatedly marked "${KIND_LABEL[kind] ?? kind}" findings as not relevant on ${cfg.type} engagements — surface them lower, or not at all, for this user.`,
    importance: 0.4,
    provenance: { source: "findings-feedback", kind, project },
  });
}

/* ---- Learned ranking: read this user's history with each finding KIND ---------
   Deterministic and auditable — computed straight from the feedback table:
     • repeated "not relevant" on a kind  → down-weight, then mute (class-level)
     • accepts / saves on a kind          → up-weight
   This is what makes the surface get quieter and smarter with use. */
function learnedSignals(project: string, user: string): { weight: Map<string, number>; muted: Set<string> } {
  const rows = getDb()
    .prepare("SELECT kind, actor, response, reason FROM finding_feedback WHERE project = ? AND actor = ?")
    .all(project, user) as { kind: string; response: string; reason: string | null }[];
  const notRel = new Map<string, number>();
  const good = new Map<string, number>();
  for (const r of rows) {
    if (r.response === "dismissed" && r.reason === "not-relevant") notRel.set(r.kind, (notRel.get(r.kind) ?? 0) + 1);
    if (r.response === "accepted" || r.response === "saved") good.set(r.kind, (good.get(r.kind) ?? 0) + 1);
  }
  const weight = new Map<string, number>();
  const muted = new Set<string>();
  for (const k of new Set([...notRel.keys(), ...good.keys()])) {
    const nr = notRel.get(k) ?? 0;
    const g = good.get(k) ?? 0;
    weight.set(k, Math.max(0.3, Math.min(1.3, 1 + g * 0.12 - nr * 0.18)));
    if (nr >= MUTE_AFTER) muted.add(k);
  }
  return { weight, muted };
}

/* ---- assessFinding — the auditable confidence read (nothing invented) -------
   Mirrors signals/assess.ts: every factor + caveat is computed from fields the
   finding already carries, so the "why rated" panel is a faithful explanation. */
export function assessFinding(f: Omit<ProjectFinding, "assessment" | "score">): FindingAssessment {
  const band: FindingAssessment["band"] = f.confidence >= 0.7 ? "high" : f.confidence >= 0.5 ? "medium" : "low";
  const factors: FindingFactor[] = [];

  factors.push({
    label: "Signal strength",
    status: f.confidence >= 0.75 ? "strong" : f.confidence >= 0.55 ? "moderate" : "weak",
    detail: `${Math.round(f.confidence * 100)}% confidence`,
  });
  factors.push({
    label: "Evidence",
    status: f.evidence.length >= 2 ? "strong" : f.evidence.length === 1 ? "moderate" : "weak",
    detail: f.evidence.length
      ? `${f.evidence.length} verbatim excerpt${f.evidence.length === 1 ? "" : "s"}`
      : "inferred — no quote",
  });
  factors.push({
    label: "Basis",
    status: "strong",
    detail: f.kind === "rising-risk" ? "risk register (deterministic)" : f.kind === "unanswered-objective" ? "objective vs corpus (deterministic)" : "model-judged",
  });

  const caveats: string[] = [];
  if (f.evidence.length === 0) caveats.push("No verbatim excerpt is attached — the claim is inferred, not quoted.");
  if (f.kind === "unanswered-objective")
    caveats.push("Absence of a corpus match isn't proof of a gap — the work may live in a doc not yet uploaded.");
  if (f.confidence < 0.65) caveats.push("Confidence is moderate — verify against the source before acting on it.");

  return { band, factors, caveats };
}

/* ---- Detectors --------------------------------------------------------------
   Each returns findings WITHOUT score/assessment; buildFindings finishes them. */
type RawFinding = Omit<ProjectFinding, "score" | "assessment">;

// rising-risk — reuse riskEarlyWarnings() (per-project, deterministic). A risk
// whose severity is climbing and still unmitigated is the archetypal "why now".
async function detectRisingRisk(project: string): Promise<RawFinding[]> {
  const warnings = (await riskEarlyWarnings()).filter((w) => w.project === project);
  return warnings.map((w) => {
    // Confidence tracks the size of the jump: low→high is a firm read, one step is a lead.
    const sev: Record<string, number> = { low: 1, medium: 2, high: 3 };
    const jump = (sev[w.to] ?? 0) - (sev[w.from] ?? 0);
    const confidence = jump >= 2 ? 0.85 : 0.68;
    return {
      id: `rr:${project}:${slug(w.risk)}`,
      project,
      kind: "rising-risk" as const,
      title: `"${w.risk}" is escalating and still unmitigated`,
      detail: `Severity ${w.from} → ${w.to} over ${w.weeks} week${w.weeks === 1 ? "" : "s"} · ${w.client}`,
      evidence: [{ quote: w.evidence, source: "risk-register.md" }],
      confidence,
      urgency: 0.9,
      trigger: `The risk register shows this rising (${w.from}→${w.to}) with no owner or mitigation in place.`,
      action: {
        title: "Draft a mitigation",
        prompt: `The risk "${w.risk}" has escalated from ${w.from} to ${w.to} over ${w.weeks} weeks and is still unmitigated. Propose a concrete mitigation and owner, grounded in the project files.`,
      },
    };
  });
}

// unanswered-objective — the signed-off objectives (objectives.md) vs the corpus.
// For each objective, the best semantic match in the files; if nothing clears the
// coverage bar, the engagement's own north star has a gap. Deterministic detection.
async function detectUnansweredObjectives(project: string): Promise<RawFinding[]> {
  const objectives = await getObjectives(project);
  if (!objectives?.length) return [];
  const out: RawFinding[] = [];
  for (const objective of objectives) {
    const sim = await topSimilarity(objective, project).catch(() => 1); // on error, assume covered (stay quiet)
    if (sim >= OBJECTIVE_COVERED) continue; // something in the files addresses it
    // The further below the coverage bar, the more confident it's a genuine gap.
    const confidence = Math.min(0.85, 0.55 + (OBJECTIVE_COVERED - sim) * 1.2);
    out.push({
      id: `uo:${project}:${slug(objective)}`,
      project,
      kind: "unanswered-objective",
      title: `No evidence yet addresses: "${objective}"`,
      detail: `A signed-off objective with nothing in the corpus speaking to it (closest match ${(sim * 100).toFixed(0)}%).`,
      evidence: [], // the ABSENCE is the point — no verbatim quote to show
      confidence,
      urgency: 0.6,
      trigger: "This is one of the engagement's objectives, but no uploaded document speaks to it yet.",
      action: {
        title: "Find what's missing",
        prompt: `The objective "${objective}" doesn't appear to be addressed by anything in the project files. What evidence or work would we need to close it, and what should I look for or ask the client?`,
      },
    });
  }
  return out;
}

const FRESH = 1; // findings are recomputed live; freshness is neutral for deterministic ones

/* ---- buildFindings — assemble, gate, rank (mirror of buildInbox) ------------ */
export async function buildFindings(project: string, user: string): Promise<ProjectFinding[]> {
  // A live engagement only — findings are about work in flight.
  const cfg = await getProjectConfig(project);
  if (cfg.status === "complete") return [];

  const raw: RawFinding[] = [
    ...(await detectRisingRisk(project)),
    ...(await detectUnansweredObjectives(project)),
  ];

  const hidden = suppressedFor(project, user);
  const { weight, muted } = learnedSignals(project, user);
  const findings: ProjectFinding[] = [];
  for (const f of raw) {
    if (hidden.has(f.id)) continue; // dismissed / snoozed / retired (exact id)
    if (muted.has(f.kind)) continue; // the user has muted this whole class
    if (f.confidence < MATERIALITY) continue; // silence beats noise
    const assessment = assessFinding(f);
    // Learned weight nudges ranking by how this user has responded to the kind before.
    const w = weight.get(f.kind) ?? 1;
    const score = Number((f.confidence * f.urgency * FRESH * w).toFixed(4));
    findings.push({ ...f, score, assessment });
  }
  return findings.sort((a, b) => b.score - a.score).slice(0, MAX_FINDINGS);
}

/* ---- Preview: "already did a little bit for you" ----------------------------
   The proof-of-value that turns a reflexive dismiss into "oh — keep that". Instead
   of OFFERING to do the work, we render a cheap DRAFT the consultant can edit or
   save. A starter, honestly labelled — the finding's `action` still runs the full,
   corpus-grounded version. Haiku + a disk cache keyed by the finding's substance, so
   it's generated once and costs nothing on re-open. */
export type FindingPreview = { heading: string; body: string };

const PREVIEW_ASK: Record<string, { heading: string; ask: string }> = {
  "rising-risk": {
    heading: "Starter mitigation",
    ask: "Draft a 2-sentence starter mitigation for this escalating risk: a concrete first action and who should own it. Practical and specific. Plain text, no preamble.",
  },
  "unanswered-objective": {
    heading: "What would close it",
    ask: "List 2–3 short, specific questions to ask or pieces of evidence to gather that would close this objective gap. One per line, each starting with '– '. No preamble.",
  },
};

function previewCacheFile(project: string): string {
  return path.join(process.cwd(), "workspace", "projects", project, "previews.json");
}

function textOf(response: Anthropic.Message): string {
  return response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}

export async function generateFindingPreview(f: ProjectFinding, project: string): Promise<FindingPreview | null> {
  const spec = PREVIEW_ASK[f.kind];
  if (!spec) return null;

  const sig = createHash("sha1").update(`${f.id}\n${f.title}\n${f.evidence.map((e) => e.quote).join("|")}`).digest("hex");
  const cacheFile = previewCacheFile(project);
  type Cache = Record<string, { sig: string; preview: FindingPreview }>;
  let cache: Cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, "utf8")) as Cache;
    if (cache[f.id]?.sig === sig) return cache[f.id].preview;
  } catch {
    /* no cache yet */
  }

  const cfg = await getProjectConfig(project);
  const evidence = f.evidence.map((e) => `- [${e.source}] "${e.quote}"`).join("\n") || "(no verbatim evidence — the gap itself is the point)";
  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 220,
    system:
      "You write a short DRAFT starter for a consultant, from a flagged finding on their engagement. Ground it strictly " +
      "in the finding provided; never invent client facts, names, or figures. It's a first draft they'll edit — be concrete " +
      "and useful, not hedged. No preamble, no sign-off.",
    messages: [
      {
        role: "user",
        content: `Engagement: "${cfg.name}" (${cfg.type}, ${cfg.sector}).\nFinding: ${f.title}\n${f.detail}\nEvidence:\n${evidence}\n\n${spec.ask}`,
      },
    ],
  });
  const body = textOf(response).trim();
  if (!body) return null;
  const preview: FindingPreview = { heading: spec.heading, body };

  cache[f.id] = { sig, preview };
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf8").catch(() => {});
  return preview;
}
