/* ---------------------------------------------------------------------------
   enrich-web.ts — optional EXTERNAL context for an opportunity or insight.

   The firm's own signals say what CLIENTS are asking. The web says whether the
   MARKET agrees — a trend that validates a proposition, a shift that challenges it,
   context on a sector. This runs a bounded, server-side web search and returns one
   short, clearly-labelled external note.

   Discipline (mirrors retrieval.ts' web guardrail): external material is labelled,
   never presented as the firm's own research, and is advisory — if the search adds
   nothing, it returns null and the card stands on its firm evidence alone.
--------------------------------------------------------------------------- */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
// Summarising a couple of search results into one line does NOT need a frontier model —
// Haiku keeps this cheap. (Web enrichment runs only in the insights build, not per load.)
const MODEL = "claude-haiku-4-5";
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 2 } as const;

// A short external-context line for a proposition/insight, or null if nothing useful.
// `subject` = the thing to validate; `sector` = scope; `angle` = what to look for.
export async function enrichWithWeb(subject: string, sector: string, angle = "recent market trends, demand shifts, or notable developments"): Promise<string | null> {
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system:
        "You add EXTERNAL market context to a consulting firm's internal opportunity. Search the web for " +
        `${angle} relevant to the subject and sector. Then output ONLY the final result: ONE tight sentence (two at most) ` +
        "of external context that validates, challenges, or enriches it, with a concrete hook (a trend, figure, or " +
        "development). If it CONTRADICTS the internal read, say so plainly. If the web adds nothing genuinely useful, output " +
        "exactly 'NONE'. Rules: do NOT narrate your search or say things like 'I'll search' or 'I have enough context'; do " +
        "NOT prefix with 'External context:'; never present external material as the firm's own research; no citations list.",
      messages: [{ role: "user", content: `Subject: ${subject}\nSector: ${sector}` }],
      tools: [WEB_SEARCH_TOOL],
    });
    // With server web-search the reply is [text preamble, tool_use, tool_result, … final text].
    // The model's answer is the LAST non-empty text block — take that, not the narration.
    const texts = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter(Boolean);
    let text = texts.length ? texts[texts.length - 1] : "";
    text = text.replace(/^external context:\s*/i, "").trim();
    if (!text || /^none$/i.test(text)) return null;
    return text;
  } catch {
    return null; // web unavailable / no key → the card stands on firm evidence alone
  }
}
