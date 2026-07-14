/* ---------------------------------------------------------------------------
   signals/behavioral.ts — signal from BEHAVIOUR, not words.

   The richest signals are often the ones nobody says out loud: an objective the
   corpus never addresses, a milestone bearing down with the plan flagging it, a
   client who has gone quiet. These are computed from the workspace's own state and
   telemetry — deterministically, no LLM — and they exist to FEED THE CONVERGENCE
   ENGINE (converge.ts), not to add more standalone cards. A behavioural signal on
   its own is weak; its value is when it lines up with what people ARE saying.
--------------------------------------------------------------------------- */

import { listProjects } from "../corpus";
import { getProjectConfig } from "../project";
import { getObjectives } from "../objectives";
import { getEngagement, engagementSummary } from "../engagement";
import { topSimilarity } from "../vectors";
import { queryAtoms } from "./atoms";
import type { UnifiedSignal } from "./converge";

const OBJECTIVE_COVERED = 0.4; // below this cosine, nothing in the corpus speaks to an objective
const QUIET_DAYS = 30; // a live account with no fresh client signal for this long has gone quiet

export async function behavioralSignals(): Promise<UnifiedSignal[]> {
  const out: UnifiedSignal[] = [];
  for (const project of await listProjects()) {
    const cfg = await getProjectConfig(project);
    if (cfg.status === "complete") continue; // behaviour signals are about live work

    // 1. Objective with no evidence — a signed-off aim the corpus never addresses.
    const objectives = await getObjectives(project).catch(() => [] as string[]);
    for (const objective of objectives ?? []) {
      const sim = await topSimilarity(objective, project).catch(() => 1);
      if (sim >= OBJECTIVE_COVERED) continue;
      out.push({
        id: `bh:obj:${project}:${objective.slice(0, 24)}`,
        modality: "behavioural",
        source: "objectives",
        project, client: cfg.client, sector: cfg.sector,
        theme: `Objective not yet evidenced: ${objective}`,
        ts: undefined,
        strength: Math.min(0.7, 0.5 + (OBJECTIVE_COVERED - sim)),
      });
    }

    // 2. Milestone bearing down that the plan itself flags as at risk.
    const eng = await getEngagement(project).catch(() => null);
    const next = eng ? engagementSummary(eng).nextMilestone : null;
    if (next?.atRisk) {
      out.push({
        id: `bh:ms:${project}`,
        modality: "behavioural",
        source: "engagement-plan",
        project, client: cfg.client, sector: cfg.sector,
        theme: `Next milestone "${next.name}" is flagged at risk`,
        ts: next.due,
        strength: 0.7,
      });
    }

    // 3. Gone quiet — no fresh client-voice signal on a live account.
    const clientAtoms = queryAtoms({ projects: [project], sourceKinds: ["client-transcript"] }).filter((a) => a.ts);
    if (clientAtoms.length) {
      const latest = clientAtoms.reduce((mx, a) => Math.max(mx, new Date(a.ts).getTime()), 0);
      const days = Math.round((Date.now() - latest) / 86_400_000);
      if (days >= QUIET_DAYS) {
        out.push({
          id: `bh:quiet:${project}`,
          modality: "behavioural",
          source: "activity",
          project, client: cfg.client, sector: cfg.sector,
          theme: `No fresh client signal from ${cfg.client} in ${Math.round(days / 7)} weeks`,
          ts: new Date(latest).toISOString(),
          strength: 0.55,
        });
      }
    }
  }
  return out;
}
