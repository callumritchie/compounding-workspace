/* GET /api/impact → the compounding metric for leadership: how much firm knowledge
   is being reused across engagements (the thing the old way of working can't show). */

import { reuseStats } from "@/lib/reuse";
import { listAllMemories } from "@/lib/memory";

export async function GET() {
  const stats = reuseStats();
  // Enrich top insights with their body text (for the dashboard).
  const all = await listAllMemories();
  const byId = new Map(all.map((m) => [`${m.scope}::${m.id}`, m]));
  const topInsights = stats.topInsights.map((t) => {
    const m = byId.get(`${t.scope}::${t.memoryId}`) ?? all.find((x) => x.id === t.memoryId);
    return { ...t, body: m?.body ?? "" };
  });
  return Response.json({ ...stats, topInsights });
}
