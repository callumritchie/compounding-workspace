# Compounding Workspace

A local, minimal workspace for **learning context engineering (RAG + memory)** by building a
consulting-team workspace where projects compound. Full PRD:
`~/.claude/plans/sparkling-greeting-wirth.md`.

Everything is designed to be **readable end-to-end** — no black boxes. Every AI turn is
inspectable in the glass box.

## Run it

1. **Add your Anthropic API key** (only required key — embeddings run locally & free):
   ```
   cp .env.local.example .env.local     # then paste your key from console.anthropic.com
   ```
2. **Install, build the vector index, run:**
   ```
   npm install
   npm run index     # chunks + embeds the corpus (first run downloads a ~90MB model)
   npm run dev       # → http://localhost:3000
   ```

## What it does (the two learning pillars)

**Memory** — small curated facts *pushed* into every prompt:
- Scope lattice: `company/policy` → `sector` → `client` → `project` → `personal`, each memory a
  markdown file you can open. Constitution (authoritative) vs learned (compounding).
- Two-tier assembly (cache-stable vs query-ranked), token budgets, trust labels — all shown in the glass box,
  including a **stacked input-composition bar** (persona · tools · memory · working context · history) that
  makes the cached-vs-per-turn split visible.
- **🧠 Memory manager**: browse the whole library by scope, edit text + importance, retract/restore, delete.
- Reinforcement on **correctness** (👍/👎), retract, applicability tags.
- **Hybrid saving**: personal memories save instantly (with a 🧠 chip in chat); shared ones are **💡 suggested**
  and wait in an approval inbox before they change the team's brain.
- **Compounding**: the agent nominates a project lesson → you review it in the ⬆ Promotions queue →
  it's abstracted + confidentiality-checked → promoted to a shared scope → future projects start stronger.
  Implicit **signals** accumulate and auto-nominate once they cross a threshold. A **client can hold several
  projects** (in-progress / complete), grouped in the switcher — a completed engagement's client-scope
  lessons flow into the next.

**Retrieval (RAG)** — large raw files *pulled* on demand:
- Local embeddings (Transformers.js, in-process), brute-force cosine vector store (JSON).
- Upload PDFs/text → extracted, chunked, embedded.
- **⚖ Compare retrieval**: one question, three ways — naïve-vector vs reranked-vector vs agentic — side by side.

## Cross-engagement intelligence (the 🔍 Interrogate tab)

Where memory + RAG compound across *every* engagement — the surface for winning more work and running it better:

- **Ask** — one question across all the firm's work (or one client), answered with **provenance** by a
  coarse → fine → extract → synthesise pipeline. **🌐 Blend in web** pulls fresh external context (client news,
  sector trends), labelled and kept separate from the firm's own evidence.
- **Surfaced for you** — a shared, proactive feed of buying signals, follow-on openings, delivery risks and
  positioning angles, mined from transcripts, risk registers and offer gaps. Grouped by outcome, **uncapped**,
  with a **confidence bar** (defaults to High) as the throttle.
- **Evidence-first, auditable confidence** — each insight shows *why* it's rated (graded drivers: signal
  strength, corroboration, freshness, verbatim evidence, breadth), the verbatim evidence trail, and a
  **counter-check** ("stress-tested against… what would change its mind") — computed from real fields, not invented.
- **Shared team notes** — anyone can leave a natural-language **correction / context / nullify** on a surfaced
  insight; it's persisted and visible to the whole team (a nullify retires it for everyone).

Plus: **live streaming** — watch the agent read files, search, and write its answer in real time — and a
per-message **▸ x-ray** (click any answer to see the tools, retrieved passages, and memories that produced it).
**Multi-chat tabs** for concurrent tasks (memory + files shared across tabs; each tab is aware of what your
other tabs are working on), markdown-rendered responses, Callum/Bob switcher (private chats, shared files &
memory), working context ("summarise **this**"), and an **eval harness** that gates every change.

## Try these
- Open `interviews/cfo-interview.md`, ask *"summarise this"* → watch it work live, then open the answer's **▸ x-ray**.
- Ask *"how should I frame the Acme recommendation?"* → see 3 memories injected + prompt caching.
- ⚖ Compare retrieval: *"why do remote care programs fail to scale?"* → naïve vs reranked vs agentic over the market report.
- Open a **＋ new tab**, start a different task, then ask a tab *"what am I working on in my other tab?"*
- Nominate a lesson → ⬆ Promotions → promote → switch to Bob + `beacon-health` → it's there.
- Open **🔍 Interrogate** → expand a surfaced insight to see its evidence + counter-check → leave a shared **correction** and watch it appear for the whole team.

## Scripts
| Command | What |
|---|---|
| `npm run dev` | Run the app |
| `npm run index` | Rebuild the vector index from the corpus |
| `npm run eval` | Run the scored golden-set regression gate |

## Where things live
| Path | What |
|---|---|
| `app/page.tsx` | The whole UI (Projects + Interrogate) |
| `app/api/*` | Endpoints (chat, files, promotions, compare, upload, signals, annotate, space query) |
| `lib/agent.ts` | The Claude calls (agent loop, reranker, abstraction) |
| `lib/memory.ts` `lib/assemble.ts` | Memory store + context assembly |
| `lib/promotion.ts` `lib/signals/*` | The compounding + signal engine (inbox, assess, annotations) |
| `lib/retrieval.ts` | Cross-project retrieval + synthesis (the Interrogate answer pipeline) |
| `lib/vectors.ts` `lib/embed.ts` `lib/chunk.ts` | The RAG arm |
| `DESIGN.md` | The shared design system + ship checklist |
| `workspace/` | All state, as plain files you can open |
