/* ---------------------------------------------------------------------------
   team.ts — who's on the team and what they're allowed to approve.

   Shared memory is only as trustworthy as the controls around it. Suggestions
   and promotions become team knowledge only when someone with the right to do
   so approves them — and how broad the scope is decides who that someone is:

     • personal/*                         → never needs approval (saves instantly)
     • project/*                          → any team member can confirm
     • stakeholder|client|sector|company/* → a LEAD only (cross-project knowledge)

   Two simulated users, two roles. In a real deployment this maps to your org's
   roles/permissions; here it's a tiny, legible table.
--------------------------------------------------------------------------- */

export type Role = "lead" | "analyst";

export const TEAM: Record<string, { role: Role; label: string }> = {
  callum: { role: "lead", label: "Lead" },
  bob: { role: "analyst", label: "Analyst" },
};

export function roleOf(user: string): Role {
  return TEAM[user]?.role ?? "analyst";
}
export function roleLabel(user: string): string {
  return TEAM[user]?.label ?? "Analyst";
}

export function levelOf(scope: string): string {
  return scope.split("/")[0];
}

// Broad, cross-project scopes that only a Lead may approve into.
const LEAD_ONLY_LEVELS = new Set(["stakeholder", "client", "sector", "company"]);

export function canApprove(user: string, scope: string): boolean {
  const level = levelOf(scope);
  if (level === "project") return true; // any team member can confirm local project memory
  if (LEAD_ONLY_LEVELS.has(level)) return roleOf(user) === "lead";
  return roleOf(user) === "lead"; // personal never reaches approval; default cautious
}

// Plain-language reason shown when approval is blocked (API message + UI lock).
export function approvalBlockReason(user: string, scope: string): string | null {
  if (canApprove(user, scope)) return null;
  return `Only a Lead can approve ${levelOf(scope)}-level memory.`;
}
