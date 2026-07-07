/* POST /api/memory/maintain → run memory maintenance (decay untouched learned
   memory a step; auto-archive anything that falls too low). Called lazily when the
   Memory manager opens, and by `npm run db:maintain`. Returns { decayed, archived }. */

import { decayMemories } from "@/lib/lifecycle";

export async function POST() {
  const result = await decayMemories();
  return Response.json(result);
}
