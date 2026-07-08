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

// Delivery roles work INSIDE projects (lead, analyst). Intelligence roles work
// ACROSS projects and never own delivery (sales, marketing) — their home is the
// cross-project lenses, not a project workspace.
export type Role = "lead" | "analyst" | "sales" | "marketing";

export const TEAM: Record<string, { role: Role; label: string }> = {
  callum: { role: "lead", label: "Lead" },
  bob: { role: "analyst", label: "Analyst" },
  dana: { role: "sales", label: "Sales / BD" },
  mo: { role: "marketing", label: "Marketing" },
};

// Delivery roles land on their engagements; intelligence roles land on the lenses.
export function isDeliveryRole(user: string): boolean {
  const r = roleOf(user);
  return r === "lead" || r === "analyst";
}

// Delivery-health signals are DERIVED FROM INTERNAL-TEAM candour — "the team is
// struggling". Surfacing that has trust implications, so it's gated to the delivery
// lead (and a future practice role), never to sales/marketing or the firm tier.
export function canSeeDeliveryHealth(user: string): boolean {
  return ["lead", "practice"].includes(roleOf(user));
}

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

// Cross-project SPACE access (ticket H1 / F2). Querying across many clients is a
// governance decision, not just a retrieval one. Account + sector lenses are open
// to the team; the firm-wide lens (which combines every client) is leadership-only.
// This is the query-time access boundary that complements de-identification.
export function canAccessSpace(user: string, spaceType: "account" | "sector" | "firm"): boolean {
  // Firm-wide combines every client → the cross-client-authorised roles only
  // (lead + the intelligence roles whose job it is). A delivery analyst can't.
  if (spaceType === "firm") return ["lead", "sales", "marketing"].includes(roleOf(user));
  return true; // account + sector open to all (cross-client results are de-identified)
}

export function spaceAccessBlockReason(user: string, spaceType: "account" | "sector" | "firm"): string | null {
  if (canAccessSpace(user, spaceType)) return null;
  return "The firm-wide lens combines every client's data — it's limited to Leads and the sales/marketing team.";
}
