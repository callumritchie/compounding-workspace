/* POST /api/findings/save { project, user, id, heading, body }
   → { ok, path } — persist a finding's preview draft into the PROJECT corpus as a
   markdown note and index it for RAG, so the "little bit already done" becomes durable
   work the team can retrieve. Also records a 'saved' response (a positive signal the
   ranker reinforces). See corpus.writeFile + vectors.addFileToIndex. */

import { writeFile } from "@/lib/corpus";
import { addFileToIndex } from "@/lib/vectors";
import { recordFindingFeedback } from "@/lib/findings";
import { isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === "string" ? body.user : "unknown";
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });

  const project = String(body.project ?? DEFAULT_PROJECT);
  const id = String(body.id ?? "");
  const kind = String(body.kind ?? "");
  const heading = String(body.heading ?? "Finding note");
  const md = String(body.body ?? "");
  if (!id || !md.trim()) return Response.json({ error: "id and body required" }, { status: 400 });

  const slug = id.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").slice(0, 60) || `finding-${Date.now().toString(36)}`;
  const rel = `notes/${slug}.md`;
  const front = `# ${heading}\n\n_Draft from a flagged finding, saved by ${user} on ${new Date().toISOString().slice(0, 10)}. Edit as needed._\n\n`;
  try {
    await writeFile(project, rel, front + md + "\n");
    await addFileToIndex(project, rel).catch(() => {}); // index best-effort — the note is saved regardless
    await recordFindingFeedback({ findingId: id, kind, project, actor: user, response: "saved" });
    return Response.json({ ok: true, path: rel });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "save failed";
    return Response.json({ error: detail }, { status: 500 });
  }
}
