/* ---------------------------------------------------------------------------
   engagement.ts — the SHAPE of the engagement, as always-on context.

   The corpus is what's *known*, memory is what's been *learned*, working context
   is the *right-now*. Missing was the engagement's own frame: the statement of
   work, timeline, budget, scope, team, and current risks. These are STANDING
   CONSTRAINTS — they bear on every recommendation, not just questions that mention
   them — so they can't live in RAG (which only surfaces on match). Instead we read
   a per-project `files/engagement.md`, parse its frontmatter deterministically, and
   render a compact digest that's injected into the context every turn.

   Frontmatter holds the hard facts; the markdown body is a freeform status
   narrative (retrievable via RAG for detail). No LLM is involved in producing the
   digest — it's cheap, always-accurate, and can't drift.
--------------------------------------------------------------------------- */

import matter from "gray-matter";
import { readFile } from "./corpus";

export const ENGAGEMENT_FILE = "engagement.md";

export type Milestone = { name: string; due?: string; status?: string };
export type Risk = { text: string; severity?: string; kind?: string };
export type TeamMember = { name: string; role?: string; availability?: string };

export type Engagement = {
  sow?: string;
  budget?: { total?: number; spent?: number; currency?: string };
  timeline?: { start?: string; end?: string; phase?: string; milestones?: Milestone[] };
  scope?: { in?: string[]; out?: string[]; changeRequests?: string[] };
  team?: TeamMember[];
  risks?: Risk[];
};

// Read + parse files/engagement.md. Returns null when the project has no such
// file, so the feature degrades gracefully (no file ⇒ no constraints block).
export async function getEngagement(projectId: string): Promise<Engagement | null> {
  let raw: string;
  try {
    raw = await readFile(projectId, ENGAGEMENT_FILE);
  } catch {
    return null;
  }
  const fm = matter(raw).data as Record<string, unknown>;
  if (!fm || Object.keys(fm).length === 0) return null;
  return normalize(fm);
}

// Tolerant shaping of the parsed frontmatter — every field is optional and we
// accept a couple of spellings (scope.in / scope.out arrays, change_requests).
function normalize(fm: Record<string, unknown>): Engagement {
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)) : v ? [String(v)] : [];
  const scope = (fm.scope ?? {}) as Record<string, unknown>;
  const timeline = (fm.timeline ?? {}) as Record<string, unknown>;
  const budget = (fm.budget ?? {}) as Record<string, unknown>;
  return {
    sow: fm.sow ? String(fm.sow) : undefined,
    budget: fm.budget
      ? { total: num(budget.total), spent: num(budget.spent), currency: budget.currency ? String(budget.currency) : "USD" }
      : undefined,
    timeline: fm.timeline
      ? {
          start: toDateStr(timeline.start),
          end: toDateStr(timeline.end),
          phase: timeline.phase ? String(timeline.phase) : undefined,
          milestones: Array.isArray(timeline.milestones)
            ? (timeline.milestones as Record<string, unknown>[]).map((m) => ({
                name: String(m.name ?? ""),
                due: toDateStr(m.due),
                status: m.status ? String(m.status) : undefined,
              }))
            : [],
        }
      : undefined,
    scope: fm.scope
      ? { in: asArray(scope.in), out: asArray(scope.out), changeRequests: asArray(scope.change_requests ?? scope.changeRequests) }
      : undefined,
    team: Array.isArray(fm.team)
      ? (fm.team as Record<string, unknown>[]).map((t) => ({
          name: String(t.name ?? ""),
          role: t.role ? String(t.role) : undefined,
          availability: t.availability ? String(t.availability) : undefined,
        }))
      : undefined,
    risks: Array.isArray(fm.risks)
      ? (fm.risks as Record<string, unknown>[]).map((r) => ({
          text: String(r.text ?? ""),
          severity: r.severity ? String(r.severity) : undefined,
          kind: r.kind ? String(r.kind) : undefined,
        }))
      : undefined,
  };
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// YAML auto-parses an unquoted `2026-08-15` into a JS Date; normalize any date-ish
// value back to a plain YYYY-MM-DD string for display + math.
function toDateStr(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length > 10 && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString().slice(0, 10) : s;
}

// Days from today until `date` (negative = overdue). null if unparseable.
function daysUntil(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

// A milestone is "strained" if it's flagged at-risk/slipping, or overdue AND not
// yet done. A completed or on-track milestone is never strained.
function milestoneStrained(m: Milestone): boolean {
  const s = (m.status ?? "").toLowerCase();
  if (s.includes("done") || s.includes("complete") || s.includes("track")) return false;
  if (s.includes("risk") || s.includes("slip") || s.includes("late") || s.includes("behind")) return true;
  const d = daysUntil(m.due);
  return d !== null && d < 0;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, med: 1, low: 2 };

// A tiny structured summary for the UI strip (phase · budget% · next milestone ·
// top risk). Computed from the same deterministic signals as the digest.
export type EngagementSummary = {
  phase?: string;
  budgetPct?: number;
  budgetLabel?: string;
  endsInDays?: number | null;
  nextMilestone?: { name: string; due?: string; atRisk: boolean };
  topRisk?: { text: string; severity?: string };
};

export function engagementSummary(eng: Engagement): EngagementSummary {
  const s: EngagementSummary = {};
  if (eng.timeline?.phase) s.phase = eng.timeline.phase;
  if (eng.timeline?.end) s.endsInDays = daysUntil(eng.timeline.end);
  if (eng.budget?.total && eng.budget.spent != null) {
    s.budgetPct = Math.round((eng.budget.spent / eng.budget.total) * 100);
    s.budgetLabel = `${s.budgetPct}% of budget`;
  }
  // Next milestone = the soonest not-yet-done one (strained ones win ties).
  const upcoming = (eng.timeline?.milestones ?? [])
    .filter((m) => !/done|complete/i.test(m.status ?? ""))
    .sort((a, b) => (daysUntil(a.due) ?? 1e9) - (daysUntil(b.due) ?? 1e9));
  if (upcoming.length) {
    const m = upcoming[0];
    s.nextMilestone = { name: m.name, due: m.due, atRisk: milestoneStrained(m) };
  }
  if (eng.risks?.length) {
    const top = eng.risks
      .slice()
      .sort((a, b) => (SEVERITY_RANK[(a.severity ?? "low").toLowerCase()] ?? 3) - (SEVERITY_RANK[(b.severity ?? "low").toLowerCase()] ?? 3))[0];
    s.topRisk = { text: top.text, severity: top.severity };
  }
  return s;
}

// The compact, always-on text block. Deterministic: derives budget %, days-to-end,
// and surfaces strained milestones + high-severity risks first so the agent sees
// what's under pressure without reading the whole brief.
export function engagementDigest(eng: Engagement): string {
  const lines: string[] = [
    "ENGAGEMENT CONSTRAINTS (weigh every recommendation against these; when a suggestion strains one, flag it in one line, citing the constraint):",
  ];
  if (eng.sow) lines.push(`- SOW: ${eng.sow}`);

  if (eng.budget && (eng.budget.total != null || eng.budget.spent != null)) {
    const { total, spent, currency } = eng.budget;
    const cur = currency ?? "USD";
    const pct = total && spent != null ? ` (${Math.round((spent / total) * 100)}% spent)` : "";
    const fmt = (n?: number) => (n == null ? "?" : `${cur === "USD" ? "$" : ""}${n.toLocaleString()}`);
    lines.push(`- Budget: ${fmt(spent)} / ${fmt(total)}${pct}`);
  }

  if (eng.timeline) {
    const { phase, end, milestones } = eng.timeline;
    const bits: string[] = [];
    if (phase) bits.push(`phase "${phase}"`);
    if (end) {
      const d = daysUntil(end);
      bits.push(`ends ${end}${d !== null ? ` (${d < 0 ? `${-d}d overdue` : `${d}d left`})` : ""}`);
    }
    if (bits.length) lines.push(`- Timeline: ${bits.join("; ")}`);
    // Strained milestones first, then the rest — but keep it short.
    const ms = (milestones ?? []).slice();
    ms.sort((a, b) => Number(milestoneStrained(b)) - Number(milestoneStrained(a)));
    for (const m of ms.slice(0, 4)) {
      const flag = milestoneStrained(m) ? " — AT RISK" : "";
      lines.push(`  · Milestone "${m.name}"${m.due ? ` due ${m.due}` : ""}${m.status ? ` [${m.status}]` : ""}${flag}`);
    }
  }

  if (eng.scope) {
    const parts: string[] = [];
    if (eng.scope.in?.length) parts.push(`IN: ${eng.scope.in.join(", ")}`);
    if (eng.scope.out?.length) parts.push(`OUT: ${eng.scope.out.join(", ")}`);
    const cr = eng.scope.changeRequests ?? [];
    parts.push(`open change requests: ${cr.length ? cr.join("; ") : "none"}`);
    if (parts.length) lines.push(`- Scope — ${parts.join(" · ")}`);
  }

  if (eng.team?.length) {
    lines.push(`- Team: ${eng.team.map((t) => `${t.name}${t.role ? ` (${t.role})` : ""}${t.availability ? ` — ${t.availability}` : ""}`).join("; ")}`);
  }

  if (eng.risks?.length) {
    const sorted = eng.risks
      .slice()
      .sort((a, b) => (SEVERITY_RANK[(a.severity ?? "low").toLowerCase()] ?? 3) - (SEVERITY_RANK[(b.severity ?? "low").toLowerCase()] ?? 3));
    lines.push(`- Active risks: ${sorted.slice(0, 4).map((r) => `[${(r.severity ?? "?").toLowerCase()}] ${r.text}`).join("; ")}`);
  }

  return lines.join("\n");
}
