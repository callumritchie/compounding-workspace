/* ---------------------------------------------------------------------------
   signals/documents.ts — mine DOCUMENTS (not just transcripts) into signals,
   PROVENANCE-AWARE. Deterministic where the structure allows (no LLM, no cost):

     • quant JSON        — metric series → a trend signal ("conversion fell 24→17%")
     • findings.md       — our own findings (firm-produced) → one signal per finding
     • uploads (.md)     — client-supplied / external documents → context signals,
                           down-weighted and flagged by provenance (a 2023 client
                           report is NOT weighed like a finding we wrote last month)

   Every document signal is scaled by provenance.ts (authority × freshness), so the
   convergence engine treats "our current work" and "their old report" differently —
   automatically. Prose extraction (assumptions/claims from narrative docs) is a
   separate LLM build-time step; this file is the deterministic floor.
--------------------------------------------------------------------------- */

import matter from "gray-matter";
import { listProjects, listFiles, readFile } from "../corpus";
import { getProjectConfig, type ProjectConfig } from "../project";
import { docProvenance, provenanceWeight } from "../provenance";
import type { UnifiedSignal } from "./converge";

type QuantMetric = { label: string; unit?: string; series?: { period: string; value: number }[]; note?: string };
type QuantFile = { origin?: string; authored?: string; doctype?: string; metrics?: QuantMetric[] };

function arrow(delta: number): string {
  return delta < 0 ? "fell" : delta > 0 ? "rose" : "held";
}

// quant/*.json — compute the direction + magnitude of each metric series.
async function quantSignals(project: string, cfg: ProjectConfig, file: string): Promise<UnifiedSignal[]> {
  let doc: QuantFile;
  try {
    doc = JSON.parse(await readFile(project, file)) as QuantFile;
  } catch {
    return [];
  }
  const prov = docProvenance(doc as Record<string, unknown>);
  const pw = provenanceWeight(prov);
  const out: UnifiedSignal[] = [];
  for (const m of doc.metrics ?? []) {
    const s = m.series ?? [];
    if (s.length < 2) continue;
    const first = s[0].value;
    const last = s[s.length - 1].value;
    if (first === last) continue;
    const pct = first !== 0 ? Math.abs((last - first) / first) : 0;
    const unit = m.unit ?? "";
    out.push({
      id: `qt:${project}:${m.label.slice(0, 24)}`,
      modality: "quant",
      source: file.split("/").pop() ?? file,
      project, client: cfg.client, sector: cfg.sector,
      theme: `${m.label} ${arrow(last - first)} ${first}${unit}→${last}${unit} over ${s.length} periods${m.note ? ` (${m.note})` : ""}`,
      ts: prov.authored,
      // A bigger move is a stronger signal; scaled by provenance (our data ≈ full weight).
      strength: Number(Math.min(0.9, 0.45 + pct).toFixed(2)) * pw.weight,
      provenance: pw.label,
    });
  }
  return out;
}

// findings.md — our own distilled findings. Each bullet is a firm-authored signal.
async function findingSignals(project: string, cfg: ProjectConfig, file: string): Promise<UnifiedSignal[]> {
  const raw = await readFile(project, file).catch(() => "");
  if (!raw.trim()) return [];
  const parsed = matter(raw);
  const prov = docProvenance(parsed.data);
  const pw = provenanceWeight(prov);
  const bullets = [...parsed.content.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].trim()).filter((b) => b.length > 12);
  return bullets.slice(0, 8).map((b, i) => ({
    id: `fd:${project}:${i}`,
    modality: "finding" as const,
    source: file.split("/").pop() ?? file,
    project, client: cfg.client, sector: cfg.sector,
    theme: b,
    ts: prov.authored,
    strength: Number((0.72 * pw.weight).toFixed(2)),
    provenance: pw.label,
  }));
}

// uploads/*.md — client-supplied / external material. Extracted as CONTEXT, not
// finding: down-weighted by provenance and flagged (stale, whose it is). It can add
// colour to a convergence but its low weight keeps it from ever driving one.
async function clientDocSignals(project: string, cfg: ProjectConfig, file: string): Promise<UnifiedSignal[]> {
  const raw = await readFile(project, file).catch(() => "");
  if (!raw.trim()) return [];
  const parsed = matter(raw);
  const prov = docProvenance(parsed.data);
  // Only mine documents that actually declare a non-firm origin — an unmarked upload
  // is treated as ours elsewhere. Their claims are context.
  if (prov.origin === "firm") return [];
  const pw = provenanceWeight(prov);
  const claims = [...parsed.content.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].trim()).filter((b) => b.length > 12);
  const heads = [...parsed.content.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  const picked = (claims.length ? claims : heads).slice(0, 4);
  return picked.map((b, i) => ({
    id: `dc:${project}:${i}`,
    modality: "document" as const,
    source: file.split("/").pop() ?? file,
    project, client: cfg.client, sector: cfg.sector,
    theme: b,
    ts: prov.authored,
    strength: Number((0.6 * pw.weight).toFixed(2)), // authority×freshness already inside pw.weight → small for old client docs
    provenance: pw.label,
  }));
}

export async function documentSignals(): Promise<UnifiedSignal[]> {
  const out: UnifiedSignal[] = [];
  for (const project of await listProjects()) {
    const cfg = await getProjectConfig(project);
    if (cfg.status === "complete") continue; // focus live engagements for now
    const files = await listFiles(project).catch(() => [] as string[]);
    for (const f of files) {
      if (f.startsWith("quant/") && f.endsWith(".json")) out.push(...(await quantSignals(project, cfg, f)));
      else if (/(^|\/)findings\.md$/i.test(f)) out.push(...(await findingSignals(project, cfg, f)));
      else if (f.startsWith("uploads/") && f.endsWith(".md")) out.push(...(await clientDocSignals(project, cfg, f)));
    }
  }
  return out;
}
