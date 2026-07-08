/* ---------------------------------------------------------------------------
   signals/aggregate.ts — Primitive C: cross-project aggregation of atoms.

   Generalises the triangulation engine from card-findings (lib/triangulate.ts) to
   signal ATOMS: cluster same-type atoms across engagements and keep the clusters
   that span several distinct projects. That's what turns "one client asked for X"
   into "clients keep asking for X" — an emergent, firm-level signal.
--------------------------------------------------------------------------- */

import { embed } from "../embed";
import { cosine } from "../vectors";
import { queryAtoms, type SignalAtom, type AtomFilter } from "./atoms";

const SIM_THRESHOLD = 0.45; // atoms this similar are the "same" signal (cross-sector variants included)

export type AtomCluster = {
  type: string;
  representative: string; // the clearest atom text in the cluster
  members: SignalAtom[];
  projects: string[];
  clients: string[];
  sectors: string[];
  evidence: string[]; // verbatim quotes
};

// Greedy single-link clustering (same shape as lib/triangulate.ts:cluster).
function group(vecs: number[][]): number[][] {
  const clusters: number[][] = [];
  for (let i = 0; i < vecs.length; i++) {
    let placed = false;
    for (const c of clusters) {
      if (c.some((j) => cosine(vecs[i], vecs[j]) >= SIM_THRESHOLD)) {
        c.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }
  return clusters;
}

// Cluster atoms (optionally filtered) and keep clusters spanning ≥ minProjects.
// Firm-tier by default: internal-transcript atoms are excluded.
export async function clusterAtoms(
  filter: AtomFilter = {},
  minProjects = 2
): Promise<AtomCluster[]> {
  const atoms = queryAtoms({ excludeInternal: true, ...filter });
  if (atoms.length === 0) return [];
  const vecs = await embed(atoms.map((a) => `${a.text} — ${a.evidence}`));
  const groups = group(vecs);

  return groups
    .map((idxs) => idxs.map((i) => atoms[i]))
    .map((members): AtomCluster => {
      const projects = [...new Set(members.map((m) => m.project))];
      const clients = [...new Set(members.map((m) => m.client))];
      const sectors = [...new Set(members.map((m) => m.sector))];
      // Representative = highest-confidence member.
      const rep = [...members].sort((a, b) => b.confidence - a.confidence)[0];
      return {
        type: rep.type,
        representative: rep.text,
        members,
        projects,
        clients,
        sectors,
        evidence: members.map((m) => m.evidence).filter(Boolean),
      };
    })
    .filter((c) => c.projects.length >= minProjects)
    .sort((a, b) => b.projects.length - a.projects.length);
}
