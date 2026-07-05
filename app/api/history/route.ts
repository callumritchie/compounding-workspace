/* GET /api/history?user=alice&chat=<chatId> → that tab's private chat history. */

import { getChatHistory, isUser } from "@/lib/workspace";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = url.searchParams.get("user");
  const chat = url.searchParams.get("chat");
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  if (!chat) return Response.json({ error: "missing chat" }, { status: 400 });
  const history = await getChatHistory(user, chat);
  return Response.json({ history });
}
