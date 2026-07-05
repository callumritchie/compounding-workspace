/* POST /api/chats/rename { user, chatId, title } → rename a chat tab. */

import { updateChatMeta, isUser } from "@/lib/workspace";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const user = b?.user;
  const chatId = b?.chatId;
  const title = typeof b?.title === "string" ? b.title.trim().slice(0, 60) : "";
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (typeof chatId !== "string" || !title) return Response.json({ error: "missing chatId/title" }, { status: 400 });
  await updateChatMeta(user, chatId, { title });
  return Response.json({ ok: true });
}
