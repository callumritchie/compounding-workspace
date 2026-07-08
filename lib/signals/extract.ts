/* ---------------------------------------------------------------------------
   signals/extract.ts — Primitive A: interaction extraction.

   Reads a project's meeting transcripts and distils each into typed SIGNAL ATOMS,
   every one carrying a VERBATIM evidence quote and a confidence — because a
   transcript-derived signal is soft, and anything that might drive an external
   action has to be traceable and gradeable before it's trusted.

   Governance is set at extraction time: atoms from INTERNAL-team transcripts are
   tagged source_kind=internal-transcript and scoped to the project, so the store's
   firm-tier reads (excludeInternal) never surface internal candour.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import matter from "gray-matter";
import { listFiles, readFile } from "../corpus";
import { getProjectConfig } from "../project";
import type { SignalAtom } from "./atoms";

const client = new Anthropic();
const FAST_MODEL = "claude-haiku-4-5"; // extraction is structured reading — Haiku is plenty

const clamp01 = (n: unknown, d = 0.5) => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : d;
};
const clampSent = (n: unknown): number | null => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : null;
};

const ALLOWED = new Set(["buying", "competitive", "objection", "unmet-need", "relationship", "delivery-risk"]);

// YAML parses `date: 2026-06-16` into a JS Date; normalise to ISO YYYY-MM-DD so
// atoms sort chronologically and freshness scoring works.
function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// Extract atoms from every transcript in a project.
export async function extractProjectAtoms(projectId: string): Promise<SignalAtom[]> {
  const cfg = await getProjectConfig(projectId);
  const files = (await listFiles(projectId).catch(() => [] as string[])).filter((f) => f.startsWith("transcripts/"));
  const out: SignalAtom[] = [];
  for (const f of files) {
    const raw = await readFile(projectId, f).catch(() => "");
    if (!raw) continue;
    const parsed = matter(raw);
    const kind = (parsed.data?.kind as string) === "internal" ? "internal-transcript" : "client-transcript";
    const date = toIsoDate(parsed.data?.date);
    const atoms = await extractOne(parsed.content, kind === "internal-transcript");
    atoms.forEach((a, i) => {
      out.push({
        id: `${projectId}:${f}:${i}`,
        type: a.type,
        text: a.text,
        evidence: a.evidence,
        source: f,
        sourceKind: kind,
        project: projectId,
        client: cfg.client,
        sector: cfg.sector,
        // Internal candour stays inside the engagement; client atoms may rise (de-identified).
        scope: kind === "internal-transcript" ? `project/${projectId}` : `client/${cfg.client}`,
        confidence: a.confidence,
        urgency: a.urgency,
        sentiment: a.sentiment,
        ts: date,
        week: "",
        status: "new",
      });
    });
  }
  return out;
}

type RawAtom = { type: string; text: string; evidence: string; confidence: number; urgency: number; sentiment: number | null };

async function extractOne(content: string, internal: boolean): Promise<RawAtom[]> {
  const focus = internal
    ? "This is an INTERNAL team conversation. Look for DELIVERY-RISK atoms (the team voicing concern, capacity strain, ambiguity) and a RELATIONSHIP atom for overall team confidence. Do NOT invent client-facing signals."
    : "This is a CLIENT meeting. Look for: BUYING (an adjacent need, budget, or future work mentioned), COMPETITIVE (a competitor/incumbent named), OBJECTION (a concern about our work), UNMET-NEED (something they want that we may not sell), and one RELATIONSHIP atom capturing the client's overall sentiment this meeting.";

  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 900,
    system:
      "You extract SIGNAL ATOMS from a consulting meeting transcript. " +
      focus +
      " Return STRICT JSON: an array of " +
      `{"type":string,"text":string,"evidence":string,"confidence":number,"urgency":number,"sentiment":number}. ` +
      "type ∈ {buying, competitive, objection, unmet-need, relationship, delivery-risk}. " +
      "text = one sharp sentence stating the signal. evidence = a SHORT VERBATIM quote from the transcript (copy exact words). " +
      "confidence 0..1 (how clearly the transcript supports it). urgency 0..1 (how time-sensitive / perishable). " +
      "sentiment ONLY for a relationship atom, -1 (hostile) to 1 (delighted); use 0 otherwise. " +
      "Only include atoms genuinely present. JSON array only, no preamble.",
    messages: [{ role: "user", content: `Transcript:\n${content}\n\nJSON:` }],
  });

  const text = response.content.find((b) => b.type === "text");
  const rawText = text && text.type === "text" ? text.text : "";
  let arr: unknown[] = [];
  try {
    arr = JSON.parse(rawText.slice(rawText.indexOf("["), rawText.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  return arr
    .map((x): RawAtom | null => {
      const o = x as Record<string, unknown>;
      const type = String(o.type ?? "");
      if (!ALLOWED.has(type) || !o.text) return null;
      return {
        type,
        text: String(o.text),
        evidence: String(o.evidence ?? ""),
        confidence: clamp01(o.confidence),
        urgency: clamp01(o.urgency),
        sentiment: type === "relationship" ? clampSent(o.sentiment) : null,
      };
    })
    .filter((a): a is RawAtom => !!a);
}
