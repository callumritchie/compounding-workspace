/* GET /api/findings?project=&user=
   → { findings } — the in-project "Findings" surface: detected, evidence-anchored
   observations about THIS engagement (rising risk, unanswered objectives), each with
   an auditable confidence read. Recomputed on demand; feedback (dismiss/snooze/accept)
   is applied inside buildFindings so a dismiss actually sticks. See lib/findings.ts. */

import { buildFindings } from "@/lib/findings";
import { isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const project = searchParams.get("project") || DEFAULT_PROJECT;
  const user = searchParams.get("user") || "callum";
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });

  try {
    const findings = await buildFindings(project, user);
    return Response.json({ findings });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "findings failed";
    return Response.json({ findings: [], error: detail }, { status: 500 });
  }
}
