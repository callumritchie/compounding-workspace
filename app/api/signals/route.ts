/* GET /api/signals → { signals, threshold }  (the implicit-signal ledger) */

import { listSignals, SIGNAL_THRESHOLD } from "@/lib/signals";

export async function GET() {
  const signals = await listSignals();
  return Response.json({ signals, threshold: SIGNAL_THRESHOLD });
}
