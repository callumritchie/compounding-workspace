/* ---------------------------------------------------------------------------
   signals/whitespace.ts — Primitive D: demand-vs-offer whitespace.

   The "new service line" engine. Clusters the UNMET-NEED atoms clients keep
   voicing, then DIFFS them against the firm's service catalogue. A recurring need
   that sits FAR from everything we sell is whitespace — demand we're turning away.

   The coverage diff is embedding-based (transformers.js runs locally), so it needs
   no API key and is deterministically testable.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { embed, embedOne } from "../embed";
import { cosine } from "../vectors";
import { clusterAtoms, type AtomCluster } from "./aggregate";

const COVERAGE_THRESHOLD = 0.45; // need this close to an offering to count as "covered"

export type Whitespace = {
  need: string; // the representative unmet need
  clients: string[];
  sectors: string[];
  count: number; // distinct clients asking
  coverageScore: number; // max similarity to any current offering (lower = whiter space)
  evidence: string[];
};

// The offerings we currently SELL (the region before "Explicitly out of scope").
export async function catalogOfferings(): Promise<string[]> {
  const file = path.join(process.cwd(), "workspace", "firm", "service-catalog.md");
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const sellable = raw.split(/explicitly out of scope/i)[0];
  // Only bold LIST items ("- **Offering** — …"), so inline emphasis in prose isn't picked up.
  const names = [...sellable.matchAll(/^\s*-\s*\*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/\(.*?\)/g, "").trim());
  return [...new Set(names)].filter((n) => n.length > 3);
}

export async function detectWhitespace(minClients = 2): Promise<Whitespace[]> {
  const clusters = await clusterAtoms({ types: ["unmet-need"] }, 2);
  if (clusters.length === 0) return [];

  const offerings = await catalogOfferings();
  const offeringVecs = offerings.length ? await embed(offerings) : [];

  const out: Whitespace[] = [];
  for (const c of clusters) {
    if (c.clients.length < minClients) continue;
    // How close is this demand to the nearest thing we sell?
    const needVec = await embedOne(c.representative);
    const coverage = offeringVecs.length ? Math.max(...offeringVecs.map((v) => cosine(needVec, v))) : 0;
    if (coverage >= COVERAGE_THRESHOLD) continue; // we already sell this — not whitespace
    out.push({
      need: c.representative,
      clients: c.clients,
      sectors: c.sectors,
      count: c.clients.length,
      coverageScore: Number(coverage.toFixed(3)),
      evidence: c.evidence,
    });
  }
  // Widest demand (most clients, whitest space) first.
  return out.sort((a, b) => b.count - a.count || a.coverageScore - b.coverageScore);
}

// Exposed for callers that want the raw clusters (e.g. the inbox's sizing).
export type { AtomCluster };
