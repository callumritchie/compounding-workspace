/* POST /api/signals/save-asset → persist a drafted artifact into the firm library
   (workspace/firm-assets/<slug>.md) so the signal becomes a durable firm output.
   Firm-authorised roles only. Returns the saved path. */

import { promises as fs } from "fs";
import path from "path";
import { canAccessSpace, roleLabel } from "@/lib/team";
import { writeFileSafe } from "@/lib/fsatomic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!canAccessSpace(user, "firm")) {
    return Response.json({ error: "Saving firm assets is limited to Leads and the sales/marketing team." }, { status: 403 });
  }
  const title = String(body.title ?? "untitled");
  const kind = String(body.kind ?? "asset");
  const md = String(body.body ?? "");
  if (!md.trim()) return Response.json({ error: "nothing to save" }, { status: 400 });

  const slug =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || `asset-${Date.now().toString(36)}`;
  const rel = path.join("firm-assets", `${slug}.md`);
  const front = `---\ntitle: ${JSON.stringify(title)}\nkind: ${JSON.stringify(kind)}\nauthor: ${user} (${roleLabel(user)})\ncreated: ${new Date().toISOString()}\n---\n\n`;
  await writeFileSafe(path.join(process.cwd(), "workspace", rel), front + md + "\n");

  return Response.json({ ok: true, path: rel });
}
