/* ---------------------------------------------------------------------------
   context.ts — "working context" (the session's right-now).

   Beyond the corpus (what exists) and chat history (what was said), the agent
   benefits from knowing what the user is doing RIGHT NOW: which file they have
   open, and their recent actions. That's what lets "summarise this" resolve to
   the open file, and lets the agent infer intent.

   We keep it tiny and inject it as a compact text block — IDs and one-liners,
   never full file bodies (the agent can read those with a tool if it wants).
--------------------------------------------------------------------------- */

export type WorkingContext = {
  projectId: string;
  openFile?: string | null;
  recentActions?: string[];
};

export function buildWorkingContext(wc: WorkingContext): string {
  const lines = [
    'WORKING CONTEXT (the user\'s current session — use this to resolve "this", "that file", etc.):',
    `- Active project: ${wc.projectId}`,
    `- Open file: ${wc.openFile || "none"}`,
  ];
  // Keep only the last few actions so this block stays small.
  const actions = (wc.recentActions ?? []).slice(-6);
  if (actions.length) lines.push(`- Recent actions: ${actions.join("; ")}`);
  return lines.join("\n");
}
