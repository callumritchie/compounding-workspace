/* ---------------------------------------------------------------------------
   tools.ts — the four tools we hand the agent.

   This is the heart of "agentic navigation": instead of us pre-selecting text
   for the agent, we give it these tools and let it decide what to open. Each
   tool is (1) a schema Claude sees, and (2) a function that runs against the
   shared corpus. `executeTool` connects the two.
--------------------------------------------------------------------------- */

import type Anthropic from "@anthropic-ai/sdk";
import { listFiles, readFile, searchFiles, writeFile } from "./corpus";
import { writeMemory } from "./memory";
import { addNomination } from "./promotion";
import { addProposal } from "./proposals";
import { noteSignal } from "./signals";
import { search } from "./vectors";
import { rerank } from "./rerank";
import { getProjectConfig } from "./project";

// The schemas Claude receives. Descriptions matter — they tell the model when
// to reach for each tool.
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List every file in the shared project corpus. Use this first to see what exists.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read the full text of one file. Use the exact path from list_files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, e.g. interviews/cfo.md" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Keyword-search the corpus for an exact word or phrase. Returns matching lines with their file and line number. Good when you know the exact term used.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to search for" } },
      required: ["query"],
    },
  },
  {
    name: "semantic_search",
    description:
      "Search the corpus by MEANING (vector search + reranking), not exact words. Casts a wide net, then reranks to the passages that best answer your query. Prefer this for conceptual questions or when the user's wording may differ from the documents' (e.g. 'willingness to pay' vs 'pricing sensitivity'), or to find where an idea is discussed across files. Use search_files instead for exact names, figures, or literal phrases.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What you're looking for, in your own words" } },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the shared corpus (e.g. a summary or synthesis). Other users will see it too.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to write, e.g. synthesis/themes.md" },
        content: { type: "string", description: "The full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save a durable fact or lesson to MEMORY so it is remembered in future conversations (unlike a file, this is pushed into every prompt). Use for stable preferences, client facts, lessons learned, or facts about a specific stakeholder — not one-off details. Choose scope: 'personal' (only this user), 'project' (shared on this project), or 'stakeholder' (a fact about a specific person that should follow them onto their OTHER projects too — set `stakeholder` to their id from the working context).",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact or lesson, in one or two sentences" },
        scope: {
          type: "string",
          enum: ["personal", "project", "stakeholder"],
          description: "personal = remembered for this user; project = shared with everyone on this project; stakeholder = tied to a specific person (follows them across projects)",
        },
        stakeholder: {
          type: "string",
          description: "Required when scope is 'stakeholder': the stakeholder's id, exactly as listed in the working context (e.g. 'acme-cfo').",
        },
      },
      required: ["fact", "scope"],
    },
  },
  {
    name: "nominate_for_promotion",
    description:
      "Nominate a lesson learned on THIS project for promotion to a broader, shared memory scope, so future projects start stronger. Use only when an insight genuinely generalises beyond this specific client. A human reviews and abstracts it before it is promoted.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The lesson, in one or two sentences" },
        target: {
          type: "string",
          enum: ["sector", "client", "company"],
          description: "sector = every project in this sector; client = this client's future projects; company = the whole firm",
        },
        reason: { type: "string", description: "Why this generalises beyond the current project" },
      },
      required: ["fact", "target", "reason"],
    },
  },
  {
    name: "note_signal",
    description:
      "Quietly log a recurring observation or pattern you notice but that isn't yet worth a full nomination. Use the SAME short 'pattern' key each time the same thing recurs, so it builds strength; once it crosses a threshold it auto-creates a promotion nomination for human review. Low-stakes — use it whenever you spot a repeating theme.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A short, stable key so repeats accumulate, e.g. healthcare-cfo-sensitivity" },
        observation: { type: "string", description: "The observation in one sentence" },
        target: {
          type: "string",
          enum: ["sector", "client", "company"],
          description: "Where it would eventually promote if it recurs enough",
        },
      },
      required: ["pattern", "observation", "target"],
    },
  },
];

// One record of a tool the agent invoked — used to show the "glass box" trace.
// `result` is a short preview of what the tool returned (e.g. retrieved passages),
// shown in the per-message X-ray.
export type TraceEntry = { tool: string; input: Record<string, unknown>; summary: string; result?: string };

// Who/what the tools act on. save_memory needs the user (for personal scope).
export type ToolContext = { projectId: string; user: string };

// Run one tool call and return { result (what the model sees), summary (what we
// show the human) }. Errors are returned as text so the agent can recover.
export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>
): Promise<{ result: string; summary: string }> {
  const { projectId, user } = ctx;
  try {
    switch (name) {
      case "list_files": {
        const files = await listFiles(projectId);
        return { result: files.join("\n") || "(no files yet)", summary: `listed ${files.length} files` };
      }
      case "read_file": {
        const p = String(input.path ?? "");
        const content = await readFile(projectId, p);
        return { result: content, summary: `read ${p}` };
      }
      case "search_files": {
        const q = String(input.query ?? "");
        const hits = await searchFiles(projectId, q);
        const text = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
        return { result: text || "(no matches)", summary: `keyword-searched "${q}" → ${hits.length} hits` };
      }
      case "semantic_search": {
        const q = String(input.query ?? "");
        // Cast a wide net (top-8 by vector similarity), then let the reranker
        // pick the passages that actually answer the query, best first. This is
        // the single, opinionated retrieval path — no comparison view needed.
        const pool = await search(q, projectId, 8);
        const order = pool.length ? await rerank(q, pool.map((h) => h.text), 4) : [];
        const hits = order.map((i) => pool[i]);
        const text = hits.map((h) => `${h.file}: ${h.text}`).join("\n---\n");
        return {
          result: text || "(no matches — the vector index may be empty; run `npm run index`)",
          summary: `semantic_search "${q}" → ${hits.length} best of ${pool.length}`,
        };
      }
      case "write_file": {
        const p = String(input.path ?? "");
        await writeFile(projectId, p, String(input.content ?? ""));
        return { result: `Wrote ${p}.`, summary: `wrote ${p}` };
      }
      case "save_memory": {
        const fact = String(input.fact ?? "");
        if (input.scope === "personal") {
          // Personal memory: only this user sees it → save immediately.
          const scope = `personal/${user}`;
          await writeMemory({
            scope,
            type: "learned",
            body: fact,
            importance: 0.2, // born low — must earn trust before it ranks highly
            provenance: { origin_user: user, origin_project: projectId, created: new Date().toISOString().slice(0, 10) },
          });
          return { result: `Saved to your personal memory.`, summary: `remembered → ${scope}` };
        }
        if (input.scope === "stakeholder") {
          // A fact about a specific person → propose it under stakeholder/<id>
          // so, once approved, it follows them onto their OTHER projects too.
          const cfg = await getProjectConfig(projectId);
          const id = String(input.stakeholder ?? "").trim();
          const person = cfg.stakeholders.find((s) => s.id === id);
          if (!person) {
            const known = cfg.stakeholders.map((s) => s.id).join(", ") || "none listed";
            return {
              result: `Unknown stakeholder id "${id}". Use one of the ids in the working context (${known}), or save this as project scope instead.`,
              summary: `stakeholder id not found: ${id || "(blank)"}`,
            };
          }
          const scope = `stakeholder/${person.id}`;
          await addProposal({ fact, scope, proposedBy: user, sourceProject: projectId });
          return {
            result: `Suggested as a memory about ${person.name} (${person.role}) — saved only if the user approves; it will then follow ${person.name} across their projects.`,
            summary: `suggested stakeholder memory → ${scope} (awaiting approval)`,
          };
        }
        // Project/shared memory changes the TEAM's brain → suggest it for the
        // user's approval instead of saving silently.
        const scope = `project/${projectId}`;
        await addProposal({ fact, scope, proposedBy: user, sourceProject: projectId });
        return {
          result: `Suggested as a shared project memory — it will be saved only if the user approves it.`,
          summary: `suggested shared memory → ${scope} (awaiting approval)`,
        };
      }
      case "nominate_for_promotion": {
        const fact = String(input.fact ?? "");
        const cfg = await getProjectConfig(projectId);
        const target = input.target === "client" ? "client" : input.target === "company" ? "company" : "sector";
        const targetScope =
          target === "client" ? `client/${cfg.client}` : target === "company" ? "company/lessons" : `sector/${cfg.sector}`;
        await addNomination({
          fact,
          targetScope,
          reason: String(input.reason ?? ""),
          nominatedBy: user,
          sourceProject: projectId,
          sourceClient: cfg.client,
        });
        return {
          result: `Nominated for promotion to ${targetScope} (pending human review).`,
          summary: `nominated → ${targetScope}`,
        };
      }
      case "note_signal": {
        const cfg = await getProjectConfig(projectId);
        const target = input.target === "client" ? "client" : input.target === "company" ? "company" : "sector";
        const targetScope =
          target === "client" ? `client/${cfg.client}` : target === "company" ? "company/lessons" : `sector/${cfg.sector}`;
        const r = await noteSignal({
          pattern: String(input.pattern ?? ""),
          observation: String(input.observation ?? ""),
          targetScope,
          sourceProject: projectId,
          sourceClient: cfg.client,
        });
        return {
          result: r.nominatedNow
            ? `Signal recorded (${r.count}/${r.threshold}) — threshold reached, created a promotion nomination for review.`
            : `Signal recorded (${r.count}/${r.threshold}).`,
          summary: `signal "${input.pattern}" ${r.count}/${r.threshold}${r.nominatedNow ? " → nominated" : ""}`,
        };
      }
      default:
        return { result: `Unknown tool: ${name}`, summary: `unknown tool ${name}` };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : "error";
    return { result: `Error: ${detail}`, summary: `error in ${name}: ${detail}` };
  }
}
