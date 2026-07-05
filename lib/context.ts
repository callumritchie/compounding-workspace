/* ---------------------------------------------------------------------------
   context.ts — "working context" (the session's right-now).

   Beyond the corpus (what exists) and chat history (what was said), the agent
   benefits from knowing what the user is doing RIGHT NOW: which file they have
   open, and their recent actions. That's what lets "summarise this" resolve to
   the open file, and lets the agent infer intent.

   We keep it tiny and inject it as a compact text block — IDs and one-liners,
   never full file bodies (the agent can read those with a tool if it wants).
--------------------------------------------------------------------------- */

export type OtherTab = { title: string; openFile?: string | null; lastActivity?: string };

export type WorkingContext = {
  projectId: string;
  openFile?: string | null;
  recentActions?: string[];
  // What the SAME user is doing in their OTHER open chat tabs (parallel tasks).
  // Compact by design — a title + open file + last message, never full history.
  otherTabs?: OtherTab[];
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

  // Cross-tab awareness: let this chat know what the user's other tabs are for,
  // so it can coordinate ("your other tab is drafting the CFO memo") without
  // seeing their full conversations.
  const tabs = (wc.otherTabs ?? []).filter((t) => t.title || t.lastActivity).slice(0, 6);
  if (tabs.length) {
    lines.push("");
    lines.push("OTHER OPEN TABS (this same user's parallel chats — for awareness; don't conflate them with this one):");
    for (const t of tabs) {
      const bits = [`"${t.title || "untitled"}"`];
      if (t.openFile) bits.push(`file: ${t.openFile}`);
      if (t.lastActivity) bits.push(`last: "${t.lastActivity.slice(0, 80)}"`);
      lines.push(`- ${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}
