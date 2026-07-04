/* GET /api/history?user=alice → that user's private chat history. */

import { getHistory, isUser } from "@/lib/workspace";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user");
  if (!isUser(user)) {
    return Response.json({ error: "unknown user" }, { status: 400 });
  }
  const history = await getHistory(user);
  return Response.json({ history });
}
