/* ---------------------------------------------------------------------------
   project.ts — a project's identity: which client, which sector, what type.

   This is what turns a flat project into a position on the SCOPE LATTICE:
   a project belongs to a client, a client sits in a sector, and everything
   sits under the company. Memory promoted up those levels is how projects
   compound (see Phase 4).
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { resolveStakeholders, type Stakeholder } from "./stakeholders";

export type ProjectStatus = "in-progress" | "complete";

// A person involved in the engagement. Defined once in the stakeholder registry
// (lib/stakeholders.ts); projects reference them by id. Re-exported here for the
// callers that already import Stakeholder from this module.
export type { Stakeholder };

export type ProjectConfig = {
  id: string;
  name: string; // human label, e.g. "Growth strategy"
  client: string; // the client organisation
  sector: string; // e.g. healthcare
  type: string; // e.g. strategy, diligence
  status: ProjectStatus; // in-progress | complete — a client can have several
  stakeholders: Stakeholder[]; // people on this project (drive the stakeholder scope)
  team: string[]; // INTERNAL team member ids on this engagement — powers "your engagements" on Home
  memoryCount?: number; // active memories in this project's OWN scope — 0 ⇒ a "cold" project (set by listProjectConfigs)
};

export async function getProjectConfig(projectId: string): Promise<ProjectConfig> {
  const file = path.join(process.cwd(), "workspace", "projects", projectId, "project.json");
  try {
    const cfg = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ProjectConfig> & {
      stakeholders?: unknown;
    };
    // project.json lists stakeholders by id (["acme-cfo", …]); resolve each to a
    // full record via the registry. Tolerate the old inline-object format too.
    const raw = Array.isArray(cfg.stakeholders) ? cfg.stakeholders : [];
    const ids = raw
      .map((s) => (typeof s === "string" ? s : (s as { id?: string })?.id))
      .filter((x): x is string => typeof x === "string");
    return {
      id: projectId,
      name: cfg.name ?? projectId,
      client: cfg.client ?? projectId,
      sector: cfg.sector ?? "unknown",
      type: cfg.type ?? "unknown",
      status: cfg.status === "complete" ? "complete" : "in-progress",
      stakeholders: await resolveStakeholders(ids),
      team: Array.isArray((cfg as { team?: unknown }).team)
        ? ((cfg as { team?: unknown }).team as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
    };
  } catch {
    // Sensible default if a project has no config file yet.
    return { id: projectId, name: projectId, client: projectId, sector: "unknown", type: "unknown", status: "in-progress", stakeholders: [], team: [] };
  }
}

// All projects with their config, for the switcher (grouped by client). Enriched
// with memoryCount (active memories in the project's OWN scope) so the UI can tell
// a "cold" project — one that hasn't accumulated any memory of its own yet — apart
// from a warm one, and offer the kickoff experience only where it's useful.
export async function listProjectConfigs(): Promise<ProjectConfig[]> {
  const { listProjects } = await import("./corpus");
  const { readMemoriesInScope } = await import("./memory");
  const ids = await listProjects();
  return Promise.all(
    ids.map(async (id) => {
      const cfg = await getProjectConfig(id);
      const own = await readMemoriesInScope(`project/${id}`);
      return { ...cfg, memoryCount: own.length };
    })
  );
}

// The tags that describe "the current situation", used to match a memory's
// applies_to filter (see lib/assemble.ts / memory.ts).
export function contextTags(cfg: ProjectConfig): Record<string, string> {
  return { sector: cfg.sector, client: cfg.client, project_type: cfg.type };
}
