/* ---------------------------------------------------------------------------
   spaces.ts — the second first-class container (ticket A1).

   A PROJECT is a unit of delivery: one engagement, tight retrieval scope, a
   producer of knowledge. A SPACE is a LENS over the shared substrate — defined by
   a retrieval scope (which projects/clients/sectors it can see) rather than by a
   single engagement. Sales, marketing, account planning and leadership work ACROSS
   projects, so they live in spaces, not projects.

   Three tiers, in increasing confidentiality risk:
     • account — all projects for ONE client (follow-on spotting, account planning)
     • sector  — all projects in a sector, across clients (sales, marketing POVs)
     • firm    — everything (leadership, signal detection)

   Spaces are plain JSON under workspace/spaces/<id>.json — legible + editable, the
   same philosophy as project.json.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { listProjectConfigs } from "./project";

export type SpaceType = "account" | "sector" | "firm";

export type Space = {
  id: string;
  name: string;
  type: SpaceType;
  // The retrieval boundary. Empty (firm) = everything. account = clients; sector =
  // sectors. projectIds can pin an explicit set (overrides the derived set).
  scope: { clients?: string[]; sectors?: string[]; projectIds?: string[] };
};

const SPACES_DIR = path.join(process.cwd(), "workspace", "spaces");

export async function listSpaces(): Promise<Space[]> {
  let names: string[];
  try {
    names = (await fs.readdir(SPACES_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const spaces = await Promise.all(
    names.map(async (n) => {
      try {
        return JSON.parse(await fs.readFile(path.join(SPACES_DIR, n), "utf8")) as Space;
      } catch {
        return null;
      }
    })
  );
  return spaces.filter((s): s is Space => !!s).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export async function getSpace(id: string): Promise<Space | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(SPACES_DIR, `${path.basename(id)}.json`), "utf8")) as Space;
  } catch {
    return null;
  }
}

export async function saveSpace(space: Space): Promise<void> {
  await fs.mkdir(SPACES_DIR, { recursive: true });
  await fs.writeFile(path.join(SPACES_DIR, `${path.basename(space.id)}.json`), JSON.stringify(space, null, 2) + "\n", "utf8");
}

// Resolve a space to the concrete set of project ids it can see — the retrieval
// boundary that every cross-project query is filtered through. firm = all projects.
export async function resolveSpaceProjects(space: Space): Promise<string[]> {
  const configs = await listProjectConfigs();
  if (space.scope.projectIds?.length) {
    const set = new Set(space.scope.projectIds);
    return configs.filter((c) => set.has(c.id)).map((c) => c.id);
  }
  const clients = space.scope.clients ? new Set(space.scope.clients) : null;
  const sectors = space.scope.sectors ? new Set(space.scope.sectors) : null;
  if (!clients && !sectors) return configs.map((c) => c.id); // firm
  return configs
    .filter((c) => (clients ? clients.has(c.client) : true) && (sectors ? sectors.has(c.sector) : true))
    .map((c) => c.id);
}

// The sectors a space spans — used to decide whether cross-CLIENT abstraction is
// required (a firm/sector answer that combines clients needs de-identification).
export async function spaceSpansMultipleClients(space: Space): Promise<boolean> {
  const configs = await listProjectConfigs();
  const ids = new Set(await resolveSpaceProjects(space));
  const clients = new Set(configs.filter((c) => ids.has(c.id)).map((c) => c.client));
  return clients.size > 1;
}
