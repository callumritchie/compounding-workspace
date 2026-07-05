/* GET  /api/chats?user=callum   → that user's tab list
   POST /api/chats { user }      → create a new tab, returns { chat } */

import { listChats, createChat, isUser } from "@/lib/workspace";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user");
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  const chats = await listChats(user);
  return Response.json({ chats });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = body?.user;
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  const chat = await createChat(user);
  return Response.json({ chat });
}
