/* POST /api/chats/agent { user, chatId, agentId } → set which agent a chat uses. */

import { updateChatMeta, isUser } from "@/lib/workspace";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const user = b?.user;
  const chatId = b?.chatId;
  const agentId = b?.agentId;
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (typeof chatId !== "string" || typeof agentId !== "string")
    return Response.json({ error: "missing chatId/agentId" }, { status: 400 });
  await updateChatMeta(user, chatId, { agentId });
  return Response.json({ ok: true });
}
