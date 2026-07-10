/* ---------------------------------------------------------------------------
   signals/connected.ts — the connected-workspace preview (DEMO).

   A glimpse of what the surface becomes once it can read the firm's OPERATING
   data alongside the project corpus, over MCP:
     • ClickUp  — the opportunities pipeline (where each deal actually is)
     • Google Drive — the resourcing plan (who's staffed against what)
     • Pricing sheets — rate cards & margins (what work is worth)

   These are MOCKED (plain JSON under workspace/connectors/) and labelled as demo
   end-to-end. Each item JOINS a connector to the corpus — that coupling is the
   point: a stalled pipeline deal next to live buying intent, a resourcing gap
   under an at-risk milestone, a whitespace need with a real price. They ride the
   same scoring, gating and evidence surfaces as every other signal.

   See VISION.md for the full picture and phasing.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import type { InboxSignal, SignalFamily, SignalRoute, ConnectedSource } from "./inbox";

const CONNECTORS_DIR = path.join(process.cwd(), "workspace", "connectors");

// Each connector file maps to one family/route so the JSON only carries content.
const SOURCE_MAP: Record<ConnectedSource, { family: SignalFamily; route: SignalRoute }> = {
  clickup: { family: "pipeline", route: "sales" },
  drive: { family: "resourcing", route: "practice" },
  pricing: { family: "pricing", route: "leadership" },
};

type ConnectorItem = {
  id: string;
  client?: string;
  sector?: string;
  project?: string;
  title: string;
  detail: string;
  evidence: string[];
  confidence: number;
  urgency: number;
  note?: string;
  support?: { clients?: string[]; sectors: string[]; projects?: string[]; count: number };
  deIdentified?: boolean;
};

type ConnectorFile = { source: ConnectedSource; label: string; items: ConnectorItem[] };

// The mk() input shape in buildInbox (score + ageDays are computed there).
type SignalSeed = Omit<InboxSignal, "score" | "ageDays">;

export async function connectedSignals(_user: string): Promise<SignalSeed[]> {
  let names: string[];
  try {
    names = (await fs.readdir(CONNECTORS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no connectors wired → the feed is just the corpus
  }

  const seeds: SignalSeed[] = [];
  for (const name of names) {
    let file: ConnectorFile;
    try {
      file = JSON.parse(await fs.readFile(path.join(CONNECTORS_DIR, name), "utf8")) as ConnectorFile;
    } catch {
      continue;
    }
    const map = SOURCE_MAP[file.source];
    if (!map) continue;
    for (const it of file.items) {
      seeds.push({
        id: `conn:${it.id}`,
        family: map.family,
        route: map.route,
        source: file.source,
        title: it.title,
        detail: it.detail,
        evidence: it.evidence ?? [],
        support: it.support,
        project: it.project,
        client: it.deIdentified ? undefined : it.client,
        sector: it.sector,
        confidence: it.confidence,
        urgency: it.urgency,
        note: it.note,
        soft: it.confidence < 0.6, // low-confidence connector intel routes as review-before-acting
        deIdentified: !!it.deIdentified,
        actions: { draft: map.family === "pipeline", nominate: true },
      });
    }
  }
  return seeds;
}
