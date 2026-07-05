/* POST /api/chats/delete { user, chatId } → remove a tab entirely. */

import { deleteChat, isUser } from "@/lib/workspace";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = body?.user;
  const chatId = body?.chatId;
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (typeof chatId !== "string") return Response.json({ error: "missing chatId" }, { status: 400 });
  await deleteChat(user, chatId);
  return Response.json({ ok: true });
}
