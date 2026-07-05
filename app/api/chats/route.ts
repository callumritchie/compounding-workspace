/* GET  /api/chats?user=callum&project=acme-health → that user's tabs IN that project
   POST /api/chats { user, project }               → create a tab in that project */

import { listChats, listChatsForProject, createChat, isUser } from "@/lib/workspace";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = url.searchParams.get("user");
  const project = url.searchParams.get("project");
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  const chats = project ? await listChatsForProject(user, project) : await listChats(user);
  return Response.json({ chats });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = body?.user;
  if (!isUser(user)) return Response.json({ error: "unknown user" }, { status: 400 });
  const projectId = typeof body?.project === "string" && body.project ? body.project : DEFAULT_PROJECT;
  const chat = await createChat(user, projectId);
  return Response.json({ chat });
}
