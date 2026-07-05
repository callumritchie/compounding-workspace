/* POST /api/chats/clear { user, chatId } → empty a tab's messages (keep the tab). */

import { clearChat, isUser } from "@/lib/workspace";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = body?.user;
  const chatId = body?.chatId;
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (typeof chatId !== "string") return Response.json({ error: "missing chatId" }, { status: 400 });
  await clearChat(user, chatId);
  return Response.json({ ok: true });
}
