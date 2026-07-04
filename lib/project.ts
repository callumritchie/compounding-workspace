/* ---------------------------------------------------------------------------
   project.ts — a project's identity: which client, which sector, what type.

   This is what turns a flat project into a position on the SCOPE LATTICE:
   a project belongs to a client, a client sits in a sector, and everything
   sits under the company. Memory promoted up those levels is how projects
   compound (see Phase 4).
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

export type ProjectConfig = {
  id: string;
  client: string; // the client organisation
  sector: string; // e.g. healthcare
  type: string; // e.g. strategy, diligence
};

export async function getProjectConfig(projectId: string): Promise<ProjectConfig> {
  const file = path.join(process.cwd(), "workspace", "projects", projectId, "project.json");
  try {
    const cfg = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ProjectConfig>;
    return {
      id: projectId,
      client: cfg.client ?? projectId,
      sector: cfg.sector ?? "unknown",
      type: cfg.type ?? "unknown",
    };
  } catch {
    // Sensible default if a project has no config file yet.
    return { id: projectId, client: projectId, sector: "unknown", type: "unknown" };
  }
}

// The tags that describe "the current situation", used to match a memory's
// applies_to filter (see lib/assemble.ts / memory.ts).
export function contextTags(cfg: ProjectConfig): Record<string, string> {
  return { sector: cfg.sector, client: cfg.client, project_type: cfg.type };
}
