/* ---------------------------------------------------------------------------
   offers.ts — the Offer join: the insight no single system can produce.

   A whitespace signal alone says "clients keep asking for X we don't sell." That's
   a hunch. The value is the JOIN — coupling that demand to two other operating
   sources so it becomes a decision:

     detectWhitespace()   →  DEMAND    which clients, how many, in their words
           ×  pricing.json     →  PRICE     an indicative range from matched comparables
           ×  resourcing.json  →  STAFFING  can we actually deliver it, and with whom
                              =  one Offer

   Your CRM doesn't know unspoken demand (it isn't a deal yet). Your pricing sheet
   doesn't know WHICH whitespace to price. Your resourcing sheet doesn't know there's
   demand to staff against. The Offer is the product of all three — a number and a
   plan that lives in none of them.

   HONESTY is what makes a bold, priced offer safe to stake on:
     • price is a RANGE from shown comparables, never a fabricated point estimate;
       no comparable ⇒ price is null ("unknown", not zero).
     • staffing is read from real bench rows and surfaces the GAP, not just good news.
     • confidence is the WEAKEST of the three legs — an offer is only as sure as its
       least-sure input — never a flattering average.
     • the stress-test names what would change its mind (thin comparables, stale
       demand, a capability we'd have to build).

   The pricing/resourcing reads are a swappable DATA CONTRACT (workspace/firm/*.json
   standing in for MCP), so going live is a source swap, not a rewrite. See VISION.md.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { embed, embedOne } from "./embed";
import { cosine } from "./vectors";
import { detectWhitespace, catalogOfferings, type Whitespace } from "./signals/whitespace";
import { queryAtoms } from "./signals/atoms";

const FIRM = path.join(process.cwd(), "workspace", "firm");

// Thresholds calibrated on the real embedding distribution (scripts/probe-sim.ts):
// genuinely-relevant comparables/skills land 0.42–0.55, unrelated work sits ≤0.29,
// so 0.40 cleanly separates a real match from the noise floor with margin.
const PRICE_MATCH = 0.4; // a comparable must be at least this close to the need to price it
const SKILL_MATCH = 0.4; // a person's skills must be at least this close to the need to count
const AVAILABLE_DAYS = 21; // rolling off within this window counts as available now
const STALE_DAYS = 60; // demand older than this earns a "still live?" caveat

type PriceComparable = { id: string; offering: string; sector: string; price: number; margin: number };
type PricingFile = { bookMarginAvg?: number; comparables?: PriceComparable[] };
type Person = { id: string; name: string; grade: string; skills: string[]; current: string | null; rollsOffInDays: number };
type OpenRole = { role: string; skills: string[] };
type ResourcingFile = { people?: Person[]; openRoles?: OpenRole[] };

export type OfferPrice = { low: number; high: number; median: number; margin: number; bookMargin: number; comparables: number } | null;
export type OfferStaffing = {
  band: "deliverable" | "tight" | "gap";
  available: { name: string; grade: string; rollsOffInDays: number }[];
  gapNote?: string;
};
export type OfferFit = { coverage: number; nearest: string; kind: "extension" | "new-capability" };
export type Offer = {
  need: string;
  demand: { count: number; sectors: string[]; clients: string[]; evidence: string[]; oldestDays?: number };
  price: OfferPrice;
  staffing: OfferStaffing;
  fit: OfferFit;
  confidence: number; // weakest of the three legs
  legs: { demand: number; price: number; staffing: number };
  stressTest: string[];
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(FIRM, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// PRICE — match the need to comparable engagements, derive a range + avg margin.
async function priceFor(need: string): Promise<{ price: OfferPrice; conf: number; matched: number }> {
  const { comparables = [], bookMarginAvg = 0.24 } = await readJson<PricingFile>("pricing.json", {});
  if (!comparables.length) return { price: null, conf: 0.3, matched: 0 };
  const needVec = await embedOne(need);
  const vecs = await embed(comparables.map((c) => c.offering));
  const matched = comparables.filter((_, i) => cosine(needVec, vecs[i]) >= PRICE_MATCH);
  if (!matched.length) return { price: null, conf: 0.3, matched: 0 };
  const prices = matched.map((m) => m.price);
  const margins = matched.map((m) => m.margin);
  const price: OfferPrice = {
    low: Math.min(...prices),
    high: Math.max(...prices),
    median: median(prices),
    margin: Number((margins.reduce((s, x) => s + x, 0) / margins.length).toFixed(2)),
    bookMargin: bookMarginAvg,
    comparables: matched.length,
  };
  // More comparables agreeing ⇒ a firmer number. One is a lead, three is a range.
  const conf = matched.length >= 3 ? 0.72 : matched.length === 2 ? 0.6 : 0.5;
  return { price, conf, matched: matched.length };
}

// STAFFING — match the need's skills against the bench; can we deliver it, with whom?
async function staffingFor(need: string): Promise<{ staffing: OfferStaffing; conf: number }> {
  const { people = [], openRoles = [] } = await readJson<ResourcingFile>("resourcing.json", {});
  if (!people.length) return { staffing: { band: "gap", available: [], gapNote: "no resourcing data connected" }, conf: 0.35 };
  const needVec = await embedOne(need);
  const skillVecs = await embed(people.map((p) => p.skills.join(", ")));
  const matched = people.map((p, i) => ({ p, sim: cosine(needVec, skillVecs[i]) })).filter((m) => m.sim >= SKILL_MATCH);
  const available = matched.filter((m) => m.p.current === null || m.p.rollsOffInDays <= AVAILABLE_DAYS).map((m) => m.p);

  let band: OfferStaffing["band"];
  let conf: number;
  let gapNote: string | undefined;
  if (available.length >= 1) {
    band = "deliverable";
    conf = available.length >= 2 ? 0.8 : 0.62; // one free person is deliverable but thin
  } else if (matched.length >= 1) {
    band = "tight";
    conf = 0.5;
    gapNote = "the people who fit are fully committed — capacity would need freeing";
  } else {
    band = "gap";
    conf = 0.35;
    const role = openRoles[0]?.role;
    gapNote = role ? `no current match — we'd need to hire (${role})` : "no skills match on the bench — a capability we'd have to build";
  }
  return {
    staffing: { band, available: available.slice(0, 3).map((p) => ({ name: p.name, grade: p.grade, rollsOffInDays: p.rollsOffInDays })), gapNote },
    conf,
  };
}

// FIT — how far is this need from the nearest thing we already sell?
async function fitFor(need: string): Promise<OfferFit> {
  const offerings = await catalogOfferings();
  if (!offerings.length) return { coverage: 0, nearest: "—", kind: "new-capability" };
  const needVec = await embedOne(need);
  const vecs = await embed(offerings);
  let best = -1;
  let idx = 0;
  vecs.forEach((v, i) => {
    const c = cosine(needVec, v);
    if (c > best) {
      best = c;
      idx = i;
    }
  });
  return { coverage: Number(best.toFixed(3)), nearest: offerings[idx], kind: best >= 0.3 ? "extension" : "new-capability" };
}

// How old is the demand? Re-read the unmet-need atoms behind this cluster (matched by
// their verbatim evidence) so a stale ask earns an honest "confirm it's still live".
function demandOldestDays(w: Whitespace): number | undefined {
  const evset = new Set(w.evidence);
  const matched = queryAtoms({ types: ["unmet-need"] }).filter((a) => a.ts && evset.has(a.evidence));
  if (!matched.length) return undefined;
  const oldest = matched.reduce((mx, a) => Math.max(mx, Date.now() - new Date(a.ts).getTime()), 0);
  return Math.round(oldest / 86_400_000);
}

// Join one whitespace need into a priced, staffable Offer.
export async function buildOffer(w: Whitespace): Promise<Offer> {
  const need = w.need;
  const [priceRes, staffRes, fit] = await Promise.all([priceFor(need), staffingFor(need), fitFor(need)]);
  const demandConf = Math.min(0.9, 0.5 + w.count * 0.1); // more clients asking ⇒ firmer demand
  const oldestDays = demandOldestDays(w);
  const confidence = Number(Math.min(demandConf, priceRes.conf, staffRes.conf).toFixed(2)); // weakest link

  const stressTest: string[] = [];
  if (priceRes.matched === 0) stressTest.push("No comparable engagement to price against yet — the price is unknown, not zero.");
  else if (priceRes.matched < 2) stressTest.push("Price rests on a single comparable — treat as indicative until more land.");
  if (staffRes.staffing.band === "tight") stressTest.push("Delivery capacity is committed — confirm we can free or hire before pitching.");
  if (staffRes.staffing.band === "gap") stressTest.push("We can't staff this from the current bench — it's a capability to build, not just sell.");
  if (fit.kind === "new-capability") stressTest.push(`This sits well outside what we sell today (closest: ${fit.nearest}) — genuine new-capability risk.`);
  if (oldestDays != null && oldestDays >= STALE_DAYS)
    stressTest.push(`Some of this demand is ${Math.round(oldestDays / 7)}+ weeks old — confirm it's still live before acting.`);

  return {
    need,
    demand: { count: w.count, sectors: w.sectors, clients: w.clients, evidence: w.evidence, oldestDays },
    price: priceRes.price,
    staffing: staffRes.staffing,
    fit,
    confidence,
    legs: { demand: Number(demandConf.toFixed(2)), price: priceRes.conf, staffing: staffRes.conf },
    stressTest,
  };
}

// Every current whitespace need, joined into an Offer. Widest, best-supported first.
export async function buildOffers(): Promise<Offer[]> {
  const ws = await detectWhitespace();
  return Promise.all(ws.map(buildOffer));
}
