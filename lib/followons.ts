/* ---------------------------------------------------------------------------
   followons.ts — the stakeholder-value plane, at two altitudes.

   The whitespace Offer (lib/offers.ts) answers "what NEW thing could we sell?".
   This answers the other two revenue questions the firm's data can uniquely join:

     1. FOLLOW-ON (near-term, named)     — a live buying signal on an account,
        anchored to the named sponsor who voiced it, matched to the adjacent
        thing we already sell. The warmest possible lead: an existing relationship
        that just told us it's ready. Single-account — the client and the person
        are the whole point, so it is NOT de-identified.

     2. PROPOSITION (broad, strategic)   — not a project but an OFFERING the firm
        could build. Recurring appetite for a theme across SEVERAL clients is a
        proposition worth developing, one altitude above any single deal. Aggregate
        and de-identified: sectors + counts, never a single client.

   Both are deterministic — the atoms already carry the words. A follow-on joins a
   buying atom to the stakeholder registry and the service catalogue; a proposition
   clusters the appetite surface (buying + unmet-need) across clients. Confidence is
   read honestly from the evidence (atom confidence; breadth of support), never
   invented, and each carries a stress-test naming what would change its mind.
--------------------------------------------------------------------------- */

import { queryAtoms, type SignalAtom } from "./signals/atoms";
import { getProjectConfig } from "./project";
import { catalogOfferings } from "./signals/whitespace";
import { accountHealth } from "./signals/temporal";
import { embed, embedOne } from "./embed";
import { cosine } from "./vectors";

const OFFERING_MATCH = 0.42; // atom must be genuinely close to an offering to name it (below this a
// "match" is noise — better to call it bespoke than propose the wrong service). Calibrated with offers.ts.
const PROPOSITION_SIM = 0.4; // appetite atoms this similar are the same theme
const STALE_DAYS = 60; // a buying signal older than this earns a "still live?" caveat

// ---- Follow-on: a named opening on an existing account ------------------------
export type FollowOn = {
  id: string;
  project: string;
  client: string;
  sector: string;
  contact: { name: string; role: string } | null; // the sponsor to reach out to, if on record
  headline: string; // what they signalled, in their words (trimmed)
  move: string; // the concrete next step — propose an adjacent offering
  offering: string | null; // the catalogue offering to expand into (null = no clean match)
  evidence: string;
  confidence: number; // how sure we are they're ready to buy (the atom's own read)
  urgency: number;
  ts?: string;
  stressTest: string[];
};

// Nearest thing we already sell to a piece of expressed intent (the expansion play).
async function nearestOffering(text: string, offerings: string[], offeringVecs: number[][]): Promise<{ name: string; sim: number } | null> {
  if (!offerings.length) return null;
  const v = await embedOne(text);
  let best = -1;
  let idx = 0;
  offeringVecs.forEach((ov, i) => {
    const c = cosine(v, ov);
    if (c > best) {
      best = c;
      idx = i;
    }
  });
  return { name: offerings[idx], sim: best };
}

export async function buildFollowOns(): Promise<FollowOn[]> {
  const buying = queryAtoms({ types: ["buying"], sourceKinds: ["client-transcript"] });
  if (!buying.length) return [];

  const offerings = await catalogOfferings();
  const offeringVecs = offerings.length ? await embed(offerings) : [];
  const declining = new Set((await accountHealth()).filter((h) => h.trend === "declining").map((h) => h.project));

  const out: FollowOn[] = [];
  for (const a of buying) {
    const cfg = await getProjectConfig(a.project);
    // getProjectConfig already resolves the id list to full records.
    const contact = cfg.stakeholders[0] ? { name: cfg.stakeholders[0].name, role: cfg.stakeholders[0].role } : null;
    const near = await nearestOffering(a.text, offerings, offeringVecs);
    const offering = near && near.sim >= OFFERING_MATCH ? near.name : null;

    const ageDays = a.ts ? Math.round((Date.now() - new Date(a.ts).getTime()) / 86_400_000) : undefined;
    const stressTest: string[] = [];
    if (!contact) stressTest.push("No named sponsor on record for this account — identify the buyer before reaching out.");
    if (ageDays != null && ageDays >= STALE_DAYS) stressTest.push(`This signal is ${Math.round(ageDays / 7)}+ weeks old — confirm the budget is still live.`);
    if (declining.has(a.project)) stressTest.push("Relationship sentiment is sliding on this account — lead with delivery reassurance, not a pitch.");
    if (!offering) stressTest.push("No clean catalogue match — scope this as a bespoke follow-on, not an off-the-shelf expansion.");

    out.push({
      id: `fo:${a.project}:${a.id}`,
      project: a.project,
      client: cfg.client,
      sector: cfg.sector,
      contact,
      headline: a.text,
      move: offering ? `Propose ${offering}` : "Scope a bespoke follow-on",
      offering,
      evidence: a.evidence || a.text,
      confidence: a.confidence,
      urgency: Math.max(a.urgency, 0.6),
      ts: a.ts,
      stressTest,
    });
  }
  // Firmest, freshest openings first.
  return out.sort((x, y) => y.confidence - x.confidence);
}

// ---- Proposition: a broad offering the firm could develop ---------------------
export type Proposition = {
  id: string;
  theme: string; // the proposition, in one line
  label: string; // theme lightly cleaned for a title (leading "they need…" stripped)
  clients: number; // distinct clients showing appetite (de-identified count)
  sectors: string[];
  evidence: string[];
  confidence: number; // breadth of appetite
  urgency: number;
  stressTest: string[];
};

type Appetite = { text: string; evidence: string; client: string; sector: string; kind: string };

// Turn a demand statement into a proposition label: strip the leading "they need /
// clients want / the client would…" framing so it reads as an offering, not a gripe.
function propositionLabel(text: string): string {
  const cleaned = text
    .replace(/^\s*(the\s+)?client(s)?\s+(would\s+(also\s+)?|need(s)?\s+|want(s)?\s+|value\s+|expect(s)?\s+)/i, "")
    .replace(/^\s*they(\s+would|\s+need|\s+want|'d|\s+value|\s+expect)?\s+/i, "")
    .replace(/^\s*(a\s+)?(need|want|desire)\s+for\s+/i, "")
    .trim();
  const s = cleaned || text.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Greedy single-link clustering over appetite embeddings (small N — dozens at most).
function clusterAppetite(items: Appetite[], vecs: number[][]): number[][] {
  const clusters: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    let placed = false;
    for (const c of clusters) {
      if (c.some((j) => cosine(vecs[i], vecs[j]) >= PROPOSITION_SIM)) {
        c.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }
  return clusters;
}

export async function buildPropositions(minClients = 2): Promise<Proposition[]> {
  // The appetite surface: what clients are actively buying AND the adjacent things
  // they keep asking for. A theme spanning several clients is a proposition, not a
  // one-off — the pattern no single engagement sees.
  const atoms: SignalAtom[] = [
    ...queryAtoms({ types: ["buying"], sourceKinds: ["client-transcript"] }),
    ...queryAtoms({ types: ["unmet-need"], sourceKinds: ["client-transcript"] }),
  ];
  if (atoms.length < minClients) return [];

  const items: Appetite[] = atoms.map((a) => ({ text: a.text, evidence: a.evidence || a.text, client: a.client, sector: a.sector, kind: a.type as string }));
  const vecs = await embed(items.map((i) => i.text));
  const clusters = clusterAppetite(items, vecs);

  const out: Proposition[] = [];
  for (const idxs of clusters) {
    const members = idxs.map((i) => items[i]);
    const clients = [...new Set(members.map((m) => m.client))];
    if (clients.length < minClients) continue; // a proposition must span the book, not one account
    const sectors = [...new Set(members.map((m) => m.sector))];
    // Representative = the most central statement (medoid), preferring an unmet-need
    // phrasing (a capability request) over a client-specific buying line — that reads
    // as an offering and is cleaner to de-identify.
    const prefer = idxs.filter((i) => items[i].kind === "unmet-need");
    const candidates = prefer.length ? prefer : idxs;
    let repIdx = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const score = idxs.reduce((sum, j) => sum + cosine(vecs[c], vecs[j]), 0);
      if (score > bestScore) {
        bestScore = score;
        repIdx = c;
      }
    }
    const theme = items[repIdx].text;
    const confidence = Number(Math.min(0.85, 0.45 + clients.length * 0.12).toFixed(2)); // wider appetite ⇒ firmer proposition

    const stressTest: string[] = [
      "Appetite is a signal, not a mandate — validate willingness to pay before building the practice.",
    ];
    if (sectors.length === 1) stressTest.push(`Concentrated in ${sectors[0]} — confirm it generalises before positioning it firm-wide.`);

    out.push({
      id: `prop:${theme.slice(0, 40)}`,
      theme,
      label: propositionLabel(theme),
      clients: clients.length,
      sectors,
      evidence: members.map((m) => m.evidence).filter(Boolean).slice(0, 5),
      confidence,
      urgency: 0.4,
      stressTest,
    });
  }
  // Widest appetite first.
  return out.sort((a, b) => b.clients - a.clients);
}
