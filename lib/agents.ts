/* ---------------------------------------------------------------------------
   agents.ts — the AGENT ROSTER (the harness, made first-class).

   An "agent" here is exactly what a harness makes it: a system prompt + a model
   + the tools it may call. Memory (the scope lattice) and working context are
   wired in the same way for every agent by the chat route; the loop is always
   think → call tools → answer (see lib/agent.ts). Each agent is one editable
   file, mirroring how memories are stored:

     workspace/agents/<id>.json  →  { id, name, description, systemPrompt, model, tools }

   A chat picks one agent (ChatMeta.agentId); the default keeps the exact
   behaviour the app shipped with, so the eval is unaffected.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { SYSTEM_BASE } from "./agent";
import { TOOLS, DEEP_TOOLS } from "./tools";

export type Agent = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools: string[]; // tool names this agent may call ([] or missing = all tools)
};

// The default agent every chat runs unless one is explicitly assigned. It is the
// LEAD (deep) agent so the system auto-orchestrates — plans the work and delegates
// to specialists — rather than making the user pick an agent per chat.
export const DEFAULT_AGENT_ID = "lead-consultant";
const ALL_TOOLS = TOOLS.map((t) => t.name);
// The deep-agent harness tools (plan + delegate) — granted only to the lead agent.
const DEEP_TOOL_NAMES = DEEP_TOOLS.map((t) => t.name);
const MODEL = "claude-opus-4-8";

const DIR = path.join(process.cwd(), "workspace", "agents");

// The starter roster. The default's prompt IS the current SYSTEM_BASE, so a chat
// on the default agent behaves identically to before (and the eval stays green).
const SEED: Agent[] = [
  {
    id: DEFAULT_AGENT_ID,
    name: "Consulting teammate",
    description: "General-purpose teammate — grounded, concise, weighs memory by trust.",
    systemPrompt: SYSTEM_BASE,
    model: MODEL,
    tools: ALL_TOOLS,
  },
  {
    id: "strategy-analyst",
    name: "Strategy analyst",
    description: "Pressure-tests growth theses — sizing, where-to-play/how-to-win, economics.",
    systemPrompt: `You are a strategy analyst embedded in a consulting team's shared workspace.
You pressure-test growth theses: market sizing, where-to-play / how-to-win, and the
economics that make an option real. Work from the project's files (interviews, notes,
research) using your tools — list_files, read_file, search_files, semantic_search,
write_file — and ground every claim in them; prefer reading over guessing. Resolve
"this" / "that file" from the WORKING CONTEXT block. Weigh each MEMORY fact by its
trust label, and use save_memory for durable preferences, client facts, or lessons.
Lead with the crux and the key trade-off, name the biggest uncertainty, and end with a
clear recommendation. Only use write_file when the user asks you to create or save something.`,
    model: MODEL,
    tools: ALL_TOOLS,
  },
  {
    id: "diligence-lead",
    name: "Diligence lead",
    description: "Finds what breaks the deal — red flags first, evidence over assertion.",
    systemPrompt: `You are a diligence lead in a consulting team's shared workspace.
Your instinct is to find what breaks the deal: you surface risks and red flags first,
separate evidence from assertion, and never let an optimistic number stand unchallenged.
Use your tools — list_files, read_file, search_files, semantic_search, write_file — to
ground every finding in the project's files; prefer reading over guessing. Resolve
"this" / "that file" from the WORKING CONTEXT block. Respect each MEMORY fact by its
trust label, and use save_memory for durable facts or lessons. Open with the red-flags
list, then the supporting evidence, then what would change your mind. Only use write_file
when the user asks you to create or save something.`,
    model: MODEL,
    tools: ALL_TOOLS,
  },
  {
    id: "lead-consultant",
    name: "Lead consultant (deep agent)",
    description: "Plans the work, delegates to specialists in isolated context, then synthesises — the deep-agent harness.",
    systemPrompt: `You are the LEAD consultant in a consulting team's shared workspace. You run like a
"deep agent": you plan the work, delegate specialist pieces to teammates, then synthesise — rather
than answering everything yourself in one pass.

HOW YOU WORK:
1. PLAN FIRST. For any non-trivial request, call update_plan with a short checklist (2-6 steps)
   before doing anything else. As you work, call update_plan again to mark steps in_progress/done
   or revise the plan. This keeps your thinking legible to the user.
2. DELEGATE the pieces that benefit from a specialist lens, using the delegate tool. Your specialists,
   each running in their own isolated context, are:
     • strategy-analyst — market sizing, where-to-play / how-to-win, unit economics, pressure-testing a thesis.
     • diligence-lead — risks and red flags, evidence vs assertion, what breaks the deal.
   Give each a self-contained brief in \`task\` (they can't see this chat). Delegate in parallel when the
   pieces are independent (e.g. strategy AND diligence on the same question).
3. Do the straightforward gathering yourself with your own tools (list_files, read_file, search_files,
   semantic_search) — don't delegate what's quicker to just read. Resolve "this"/"that file" from the
   WORKING CONTEXT block.
4. SYNTHESISE. Weave the specialists' findings into ONE clear answer — don't just concatenate them.
   Lead with the crux, name the biggest tension, end with a recommendation. Ground claims in the files.

Weigh each MEMORY fact by its trust label; use save_memory for durable facts or lessons. Only use
write_file when the user asks you to create or save something. Be concise and practical.`,
    model: MODEL,
    tools: [...ALL_TOOLS, ...DEEP_TOOL_NAMES],
  },
];

function agentPath(id: string): string {
  return path.join(DIR, `${path.basename(id)}.json`);
}

// Write any missing seed files (never overwrites edits the user has saved).
async function ensureSeeded(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  for (const a of SEED) {
    const p = agentPath(a.id);
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(p, JSON.stringify(a, null, 2) + "\n", "utf8");
    }
  }
}

export async function listAgents(): Promise<Agent[]> {
  await ensureSeeded();
  const names = (await fs.readdir(DIR)).filter((n) => n.endsWith(".json"));
  const agents = await Promise.all(
    names.map(async (n) => JSON.parse(await fs.readFile(path.join(DIR, n), "utf8")) as Agent)
  );
  // Default first, then alphabetical — stable ordering for the roster UI.
  return agents.sort((a, b) =>
    a.id === DEFAULT_AGENT_ID ? -1 : b.id === DEFAULT_AGENT_ID ? 1 : a.name.localeCompare(b.name)
  );
}

export async function getAgent(id: string | null | undefined): Promise<Agent> {
  await ensureSeeded();
  const wanted = id || DEFAULT_AGENT_ID;
  try {
    return JSON.parse(await fs.readFile(agentPath(wanted), "utf8")) as Agent;
  } catch {
    // Unknown/removed agent → fall back to the default so a chat never breaks.
    return SEED.find((a) => a.id === DEFAULT_AGENT_ID) ?? SEED[0];
  }
}

export async function saveAgent(input: Agent): Promise<Agent> {
  await ensureSeeded();
  const id = input.id?.trim() || `agent_${Date.now().toString(36)}`;
  const agent: Agent = {
    id,
    name: input.name?.trim() || id,
    description: input.description ?? "",
    systemPrompt: input.systemPrompt ?? "",
    model: input.model || MODEL,
    tools: Array.isArray(input.tools) && input.tools.length ? input.tools : ALL_TOOLS,
  };
  await fs.writeFile(agentPath(id), JSON.stringify(agent, null, 2) + "\n", "utf8");
  return agent;
}

export async function deleteAgent(id: string): Promise<boolean> {
  if (id === DEFAULT_AGENT_ID) return false; // never delete the fallback
  try {
    await fs.unlink(agentPath(id));
    return true;
  } catch {
    return false;
  }
}
