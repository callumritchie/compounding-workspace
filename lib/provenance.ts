/* ---------------------------------------------------------------------------
   provenance.ts — how much a document's content should COUNT, and as WHAT.

   Not all evidence is equal. A finding WE produced on a live engagement last month
   is current firm knowledge. A market report the CLIENT handed us, written in 2023,
   is context — their claim, possibly stale — and must not be weighed as if it were
   our own fresh analysis. The signal engine has to know the difference.

   Two independent axes, read from a document's frontmatter:
     • AUTHORITY  — who produced it. firm = our analysis (authoritative); client =
       their assertion (context); external = third-party (context).
     • FRESHNESS  — how old the CONTENT is (its authored date, not when we filed it).

   The product of the two is the weight a document's signals carry, plus a plain
   `label` and a `stale` flag so the UI can say "client-supplied · 2yr old" out loud.
--------------------------------------------------------------------------- */

export type Origin = "firm" | "client" | "external";

export type DocProvenance = {
  origin: Origin;
  authored?: string; // ISO date the content was produced
  doctype?: string; // report | research | quant | findings | transcript | interview | working | note
  by?: string;
};

const STALE_MONTHS = 18; // content older than this is flagged stale
const MS_PER_MONTH = 30 * 86_400_000;

// YAML frontmatter auto-parses `authored: 2023-02-01` into a Date object (JSON keeps
// it a string) — accept both, or the date silently reads as "undated".
function asDateString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return undefined;
}

// Read provenance from a file's parsed frontmatter (gray-matter `data`). Sensible
// defaults: unmarked docs are treated as firm-produced (our workspace), undated.
export function docProvenance(fm: Record<string, unknown> = {}): DocProvenance {
  const origin: Origin = fm.origin === "client" ? "client" : fm.origin === "external" ? "external" : "firm";
  const authored = asDateString(fm.authored) ?? asDateString(fm.date);
  return {
    origin,
    authored,
    doctype: typeof fm.doctype === "string" ? fm.doctype : typeof fm.kind === "string" ? fm.kind : undefined,
    by: typeof fm.by === "string" ? fm.by : undefined,
  };
}

// How authoritative the content is as EVIDENCE. Our own analysis outweighs a
// third-party's assertion — the latter is context to weigh, not a finding to trust.
export function authority(p: DocProvenance): number {
  return p.origin === "firm" ? 1.0 : p.origin === "client" ? 0.6 : 0.5;
}

// Decay by the CONTENT's age. Recent (≤6mo) full weight; then linear down to a 0.2
// floor by ~3 years. Undated content gets a neutral-cautious 0.6.
export function freshness(p: DocProvenance, now = Date.now()): number {
  if (!p.authored) return 0.6;
  const t = new Date(p.authored).getTime();
  if (!Number.isFinite(t)) return 0.6;
  const months = (now - t) / MS_PER_MONTH;
  if (months <= 6) return 1.0;
  if (months >= 36) return 0.2;
  return Number((1.0 - ((months - 6) / 30) * 0.8).toFixed(2)); // 6mo→1.0 … 36mo→0.2
}

export function ageMonths(p: DocProvenance, now = Date.now()): number | undefined {
  if (!p.authored) return undefined;
  const t = new Date(p.authored).getTime();
  return Number.isFinite(t) ? Math.round((now - t) / MS_PER_MONTH) : undefined;
}

// The combined weight a document's signals should carry, plus a legible label.
export function provenanceWeight(p: DocProvenance, now = Date.now()): { weight: number; stale: boolean; label: string } {
  const a = authority(p);
  const f = freshness(p, now);
  const months = ageMonths(p, now);
  const stale = months != null && months >= STALE_MONTHS;
  const who = p.origin === "firm" ? "our work" : p.origin === "client" ? "client-supplied" : "external";
  const age = months == null ? "undated" : months < 12 ? `${months}mo old` : `${Math.round(months / 12)}yr old`;
  return {
    weight: Number((a * f).toFixed(3)),
    stale,
    label: `${who} · ${age}${stale ? " · stale" : ""}`,
  };
}
