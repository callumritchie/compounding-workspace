/* GET /api/kickoff?project=&user=[&refresh=1]
   → { brief, questions } — the day-one "what we already know going in" briefing
   assembled from inherited scope memory + the kick-off brief. Cached per project
   against a signature of its inputs (see draftKickoff); refresh=1 forces a rebuild
   (used after the intake interview seeds new facts). */

import { draftKickoff } from "@/lib/agent";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const project = searchParams.get("project") || DEFAULT_PROJECT;
  const user = searchParams.get("user") || "callum";
  const refresh = searchParams.get("refresh") === "1";
  try {
    const kickoff = await draftKickoff(project, user, { refresh });
    return Response.json(kickoff);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "kickoff failed";
    return Response.json({ brief: "", questions: [], error: detail }, { status: 500 });
  }
}
