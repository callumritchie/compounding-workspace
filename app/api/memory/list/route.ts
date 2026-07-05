/* GET /api/memory/list
   → every memory across all scopes (including retracted), for the memory
   manager. The glass box shows what's injected THIS turn; this shows the whole
   library so you can curate it. */

import { listAllMemories } from "@/lib/memory";

export async function GET() {
  const memories = await listAllMemories();
  return Response.json({ memories });
}
