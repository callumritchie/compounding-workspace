/* GET /api/next-actions?project=&user=&chatId=
   → { stage, actions, offer } — the "Compass": where this engagement is + the
   best next moves, inferred from the real state (project, inherited memory,
   corpus, recent chat). Powers the always-on next-steps strip and the single
   proactive offer in the bottom-right nudge. See inferNextActions in lib/agent. */

import { inferNextActions } from "@/lib/agent";
import { getChatHistory, isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const project = searchParams.get("project") || DEFAULT_PROJECT;
  const user = searchParams.get("user") || "callum";
  const chatId = searchParams.get("chatId");
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });

  // Compact digest of what the user's been doing in THIS chat — the last few
  // messages, roles labelled, truncated. Grounds the suggestions in the moment.
  let recent = "";
  if (chatId) {
    const history = await getChatHistory(user, chatId).catch(() => []);
    recent = history
      .slice(-6)
      .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content.slice(0, 200)}`)
      .join("\n");
  }

  try {
    const next = await inferNextActions(project, user, recent);
    return Response.json(next);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "next-actions failed";
    return Response.json({ stage: { label: "", rationale: "" }, actions: [], offer: null, error: detail }, { status: 500 });
  }
}
