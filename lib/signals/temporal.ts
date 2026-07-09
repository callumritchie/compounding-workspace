/* ---------------------------------------------------------------------------
   signals/temporal.ts — Primitive B: time-series signals.

   A static card can't express CHANGE. This reads the week-by-week risk registers
   and the timestamped relationship atoms to compute what only trajectory reveals:

     • riskEarlyWarnings   — a live engagement's risk escalating, still unmitigated
     • mitigationPlaybook  — which mitigations actually RESOLVED which risks, learned
                             across the whole book (evidence-based, not opinion)
     • accountHealth       — sentiment slope across a client's meetings → churn risk
     • deliveryHealth      — internal strain + risk velocity + milestone strain
                             (gated: derived from internal-team candour)

   Scoring is deterministic; no LLM — the atoms already carry the words.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { getProjectConfig } from "../project";
import { listProjects } from "../corpus";
import { getEngagement, engagementSummary } from "../engagement";
import { queryAtoms } from "./atoms";

const SEV: Record<string, number> = { low: 1, medium: 2, high: 3 };
const RESOLVED = new Set(["resolved", "mitigated", "closed"]);
const FAILED = new Set(["stalled", "open"]);

export type RiskRow = { week: string; risk: string; severity: string; mitigation: string; status: string };

// Parse a project's risk-register.md markdown table into rows.
export async function parseRiskRegister(projectId: string): Promise<RiskRow[]> {
  const file = path.join(process.cwd(), "workspace", "projects", projectId, "files", "risk-register.md");
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) return [];
  const rows: RiskRow[] = [];
  for (const line of raw.split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 5) continue;
    if (/^week$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue; // header / divider
    rows.push({ week: cells[0], risk: cells[1], severity: cells[2].toLowerCase(), mitigation: cells[3], status: cells[4].toLowerCase() });
  }
  return rows;
}

// Normalise a risk description to a theme key so the same risk clusters across projects.
function riskKey(risk: string): string {
  return risk.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z ]/g, "").split(" ").filter(Boolean).slice(0, 6).join(" ");
}

// ---- Early warning: a LIVE engagement's risk rising and still unmitigated -----
export type RiskWarning = { project: string; client: string; sector: string; risk: string; from: string; to: string; weeks: number; evidence: string };

export async function riskEarlyWarnings(): Promise<RiskWarning[]> {
  const out: RiskWarning[] = [];
  for (const p of await listProjects()) {
    const cfg = await getProjectConfig(p);
    if (cfg.status === "complete") continue; // early warning is about LIVE work
    const rows = await parseRiskRegister(p);
    const byRisk = new Map<string, RiskRow[]>();
    for (const r of rows) (byRisk.get(riskKey(r.risk)) ?? byRisk.set(riskKey(r.risk), []).get(riskKey(r.risk))!).push(r);
    for (const series of byRisk.values()) {
      if (series.length < 2) continue;
      const first = series[0], last = series[series.length - 1];
      const rising = (SEV[last.severity] ?? 0) > (SEV[first.severity] ?? 0);
      const unmitigated = FAILED.has(last.status) && /pending|none|no owner/i.test(last.mitigation);
      if (rising && unmitigated) {
        out.push({
          project: p, client: cfg.client, sector: cfg.sector, risk: last.risk,
          from: first.severity, to: last.severity, weeks: series.length,
          evidence: `${first.week} ${first.severity} → ${last.week} ${last.severity}; mitigation: ${last.mitigation}`,
        });
      }
    }
  }
  return out;
}

// ---- Mitigation effectiveness playbook (cross-project) -----------------------
export type PlaybookEntry = {
  riskTheme: string;
  mitigations: { mitigation: string; worked: number; failed: number; projects: string[] }[];
  recommended: string | null;
  sectors: string[];
};

export async function mitigationPlaybook(minProjects = 2): Promise<PlaybookEntry[]> {
  // For each project × risk theme, take the FINAL row (its outcome).
  const finals: { project: string; sector: string; key: string; risk: string; mitigation: string; status: string }[] = [];
  for (const p of await listProjects()) {
    const cfg = await getProjectConfig(p);
    const rows = await parseRiskRegister(p);
    const byRisk = new Map<string, RiskRow[]>();
    for (const r of rows) (byRisk.get(riskKey(r.risk)) ?? byRisk.set(riskKey(r.risk), []).get(riskKey(r.risk))!).push(r);
    for (const [key, series] of byRisk) {
      const last = series[series.length - 1];
      finals.push({ project: p, sector: cfg.sector, key, risk: last.risk, mitigation: last.mitigation, status: last.status });
    }
  }

  const byTheme = new Map<string, typeof finals>();
  for (const f of finals) (byTheme.get(f.key) ?? byTheme.set(f.key, []).get(f.key)!).push(f);

  const out: PlaybookEntry[] = [];
  for (const [, group] of byTheme) {
    if (new Set(group.map((g) => g.project)).size < minProjects) continue;
    const byMit = new Map<string, { worked: number; failed: number; projects: string[] }>();
    for (const g of group) {
      // Collapse mitigations to a short key (the leading clause) so variants group.
      const mk = g.mitigation.toLowerCase().replace(/[;.].*$/, "").trim();
      const e = byMit.get(mk) ?? byMit.set(mk, { worked: 0, failed: 0, projects: [] }).get(mk)!;
      if (RESOLVED.has(g.status)) e.worked += 1;
      else e.failed += 1;
      if (!e.projects.includes(g.project)) e.projects.push(g.project);
    }
    const mitigations = [...byMit.entries()].map(([mitigation, v]) => ({ mitigation, ...v }));
    const best = mitigations.filter((m) => m.worked > 0).sort((a, b) => b.worked - a.worked || a.failed - b.failed)[0];
    out.push({
      riskTheme: group[0].risk,
      mitigations,
      recommended: best?.mitigation ?? null,
      sectors: [...new Set(group.map((g) => g.sector))],
    });
  }
  return out.sort((a, b) => b.mitigations.length - a.mitigations.length);
}

// ---- Account health: sentiment trajectory across a client's meetings ---------
export type AccountHealth = { project: string; client: string; sector: string; slope: number; latest: number; meetings: number; trend: "declining" | "improving" | "flat"; evidence: string; ts: string };

export async function accountHealth(): Promise<AccountHealth[]> {
  const out: AccountHealth[] = [];
  for (const p of await listProjects()) {
    const cfg = await getProjectConfig(p);
    if (cfg.status === "complete") continue; // churn risk is about live accounts
    const rel = queryAtoms({ projects: [p], types: ["relationship"], sourceKinds: ["client-transcript"] })
      .filter((a) => a.sentiment != null && a.ts)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    if (rel.length < 2) continue;
    const first = rel[0].sentiment!, latest = rel[rel.length - 1].sentiment!;
    const slope = latest - first;
    const trend = slope <= -0.4 ? "declining" : slope >= 0.4 ? "improving" : "flat";
    out.push({
      project: p, client: cfg.client, sector: cfg.sector,
      slope: Number(slope.toFixed(2)), latest: Number(latest.toFixed(2)), meetings: rel.length, trend,
      evidence: rel[rel.length - 1].evidence || rel[rel.length - 1].text,
      ts: rel[rel.length - 1].ts,
    });
  }
  // Most-declining first.
  return out.sort((a, b) => a.slope - b.slope);
}

// ---- Delivery health: gated composite from INTERNAL candour + risk velocity ---
export type DeliveryHealth = { project: string; client: string; sector: string; score: number; band: "at-risk" | "watch" | "healthy"; drivers: string[]; evidence: string };

export async function deliveryHealth(): Promise<DeliveryHealth[]> {
  const out: DeliveryHealth[] = [];
  for (const p of await listProjects()) {
    const cfg = await getProjectConfig(p);
    if (cfg.status === "complete") continue;
    const drivers: string[] = [];
    let penalty = 0;

    const internal = queryAtoms({ projects: [p], types: ["delivery-risk"], sourceKinds: ["internal-transcript"] });
    if (internal.length) { penalty += Math.min(0.4, internal.length * 0.1); drivers.push(`${internal.length} internal concern${internal.length === 1 ? "" : "s"} raised`); }

    const rows = await parseRiskRegister(p);
    if (rows.length) {
      const first = rows[0], last = rows[rows.length - 1];
      if ((SEV[last.severity] ?? 0) > (SEV[first.severity] ?? 0)) { penalty += 0.3; drivers.push("risk severity rising week-on-week"); }
    }

    const eng = await getEngagement(p);
    if (eng && engagementSummary(eng).nextMilestone?.atRisk) { penalty += 0.3; drivers.push("next milestone at risk"); }

    if (drivers.length === 0) continue;
    const score = Number(Math.max(0, 1 - penalty).toFixed(2));
    const band = score < 0.5 ? "at-risk" : score < 0.75 ? "watch" : "healthy";
    out.push({
      project: p, client: cfg.client, sector: cfg.sector, score, band, drivers,
      evidence: internal[0]?.evidence || drivers[0],
    });
  }
  return out.sort((a, b) => a.score - b.score);
}
