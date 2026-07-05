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
- Reinforcement on **correctness** (👍/👎), retract (✕), applicability tags.
- **Compounding**: the agent nominates a project lesson → you review it in the ⬆ Promotions queue →
  it's abstracted + confidentiality-checked → promoted to a shared scope → future projects start stronger.
  Implicit **signals** accumulate and auto-nominate once they cross a threshold.

**Retrieval (RAG)** — large raw files *pulled* on demand:
- Local embeddings (Transformers.js, in-process), brute-force cosine vector store (JSON).
- Upload PDFs/text → extracted, chunked, embedded.
- **⚖ Compare retrieval**: one question, three ways — naïve-vector vs reranked-vector vs agentic — side by side.

Plus: **multi-chat tabs** for concurrent tasks (memory + files shared across tabs; each tab is aware of what
your other tabs are working on), markdown-rendered responses, Alice/Bob switcher (private chats, shared files
& memory), working context ("summarise **this**"), and an **eval harness** that gates every change.

## Try these
- Open `interviews/cfo-interview.md`, ask *"summarise this"* → watch the glass-box trace + input-composition bar.
- Ask *"how should I frame the Acme recommendation?"* → see 3 memories injected + prompt caching.
- ⚖ Compare retrieval: *"why do remote care programs fail to scale?"* → naïve vs reranked vs agentic over the market report.
- Open a **＋ new tab**, start a different task, then ask a tab *"what am I working on in my other tab?"*
- Nominate a lesson → ⬆ Promotions → promote → switch to Bob + `beacon-health` → it's there.

## Scripts
| Command | What |
|---|---|
| `npm run dev` | Run the app |
| `npm run index` | Rebuild the vector index from the corpus |
| `npm run eval` | Run the scored golden-set regression gate |

## Where things live
| Path | What |
|---|---|
| `app/page.tsx` | The whole UI |
| `app/api/*` | Endpoints (chat, files, promotions, compare, upload, feedback, signals) |
| `lib/agent.ts` | The Claude calls (agent loop, reranker, abstraction) |
| `lib/memory.ts` `lib/assemble.ts` | Memory store + context assembly |
| `lib/promotion.ts` `lib/signals.ts` | The compounding engine |
| `lib/vectors.ts` `lib/embed.ts` `lib/chunk.ts` | The RAG arm |
| `workspace/` | All state, as plain files you can open |
