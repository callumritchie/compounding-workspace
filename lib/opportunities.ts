/* ---------------------------------------------------------------------------
   opportunities.ts — proactive opportunity spotting (tickets E2, and the BD/
   productization framings used by sector/firm spaces).

   Cross-project VALUE is often latent: an adjacent need that recurs across a
   client's projects (follow-on work), or a pattern that recurs across a sector
   (a productizable offering / a BD play / a POV). Nobody queries for these — they
   have to be surfaced. This scans a space's project CARDS (the distilled layer) and
   proposes structured opportunities, each grounded in the engagements that support
   it. Cross-client spaces are de-identified.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";
import { getCard, type ProjectCard } from "./cards";
import { resolveSpaceProjects, spaceSpansMultipleClients, type Space } from "./spaces";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

export type Opportunity = {
  title: string;
  kind: string; // follow-on | expansion | risk | offering | pov | bd-play
  rationale: string;
  suggestedAction: string;
  projects: string[]; // titles of the engagements that support it
};

// What we're looking for depends on the lens.
function framingFor(type: Space["type"]): string {
  if (type === "account")
    return "You are spotting FOLLOW-ON work for ONE client: adjacent problems that surfaced in delivery and could be scoped as a next engagement, plus risks worth a proactive conversation.";
  if (type === "sector")
    return "You are spotting SECTOR plays across clients: recurring problems that could become a productized offering, a point of view, or a business-development angle for similar prospects.";
  return "You are spotting FIRM-LEVEL opportunities: patterns recurring across sectors that could become a cross-practice offering, a thought-leadership POV, or a strategic bet.";
}

export async function spotOpportunities(space: Space): Promise<{ opportunities: Opportunity[]; abstracted: boolean; spanned: number }> {
  const projectIds = await resolveSpaceProjects(space);
  const cards = projectIds.map(getCard).filter((c): c is ProjectCard => !!c);
  if (cards.length === 0) return { opportunities: [], abstracted: false, spanned: 0 };

  const abstract = await spaceSpansMultipleClients(space);
  // The card layer IS the distilled evidence — feed titles, findings, outcomes.
  const evidence = cards
    .map((c, i) => {
      const who = abstract ? `Engagement ${i + 1} (${c.sector}, ${c.type})` : `${c.title} — ${c.client} (${c.sector})`;
      return `## ${who}\n${c.summary}\nFindings: ${c.keyFindings.join("; ")}\nOutcome: ${c.outcome}`;
    })
    .join("\n\n");

  const abstractRule = abstract
    ? "This spans MULTIPLE CLIENTS — never name a client; refer to engagements generically. "
    : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1600,
    system:
      framingFor(space.type) +
      " Propose only opportunities GROUNDED in the evidence — prefer ones supported by MORE THAN ONE engagement. " +
      abstractRule +
      "Return STRICT JSON: {\"opportunities\":[{\"title\":string,\"kind\":string,\"rationale\":string,\"suggestedAction\":string,\"projects\":string[]}]}. " +
      "title ≤8 words. kind ∈ {follow-on, expansion, risk, offering, pov, bd-play}. rationale = ONE sentence citing what recurs. " +
      "suggestedAction = the concrete next step, ≤15 words. projects = the engagement titles that support it. Exactly 3–4 " +
      "opportunities, best first, kept short so the JSON is complete. JSON only, no preamble.",
    messages: [{ role: "user", content: `Engagements in scope:\n\n${evidence}\n\nJSON:` }],
  });

  const text = response.content.find((b) => b.type === "text");
  let parsed: { opportunities?: unknown } = {};
  try {
    const raw = text && text.type === "text" ? text.text : "";
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    parsed = {};
  }
  const opportunities: Opportunity[] = Array.isArray(parsed.opportunities)
    ? (parsed.opportunities as Record<string, unknown>[]).slice(0, 6).map((o) => ({
        title: String(o.title ?? ""),
        kind: String(o.kind ?? "follow-on"),
        rationale: String(o.rationale ?? ""),
        suggestedAction: String(o.suggestedAction ?? ""),
        projects: Array.isArray(o.projects) ? (o.projects as unknown[]).map(String).slice(0, 6) : [],
      }))
    : [];
  return { opportunities, abstracted: abstract, spanned: cards.length };
}
