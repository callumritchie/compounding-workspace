# Vision: the connected workspace

Today this product reasons over one substrate — the **project corpus**: transcripts, risk
registers, engagement configs, and the signals we derive from them (`lib/signals/*`). That
already turns scattered delivery data into a prioritised, evidence-backed feed.

The next step is not a smarter model. It's **more of the firm's own context**. Most of what
makes a signal *actionable* lives in the operating tools the team already uses every day —
and those tools speak MCP.

---

## The sources we'd connect

| Source (via MCP) | What it holds | What it adds to a signal |
| --- | --- | --- |
| **ClickUp** | Opportunities pipeline — every deal, its stage, owner, value, age | *Where* a relationship actually is commercially |
| **Google Drive** | Resourcing plan — who's staffed against what, who's rolling off, open roles | *Whether we can deliver* what we're about to sell or promise |
| **Pricing sheets** | Rate cards, comparable-engagement prices, margins | *What the work is worth* — turning a hunch into a priced offer |

Together with the project corpus, that's close to the firm's whole operating knowledge in
one place.

## Why coupling beats connecting

A connector on its own is just another dashboard. The value is in the **join** — a signal
that neither source could produce alone:

- **Pipeline × buying intent.** ClickUp shows the Acme expansion stalled 21 days in
  "Proposal". The corpus shows Acme's buying intent is live *right now*. Neither is urgent
  alone; together they say *re-engage this week*.
- **Resourcing × delivery health.** Delivery-health already flags Meridian Health's next
  milestone as at-risk. The resourcing sheet shows the senior data engineer for that
  milestone is unstaffed. The symptom now has a cause — and a fix.
- **Whitespace × pricing.** A whitespace signal shows several healthcare clients asking for
  a "managed data platform" we don't sell. The pricing sheet says comparable builds land at
  ~£120k with healthy margin. That's a quantified, priced offer instead of a hunch.

These three are live in the prototype today as a **labelled demo** (see below).

## It rides the existing trust model

Connectors don't get a bypass. They flow through the same discipline already in
`lib/signals/inbox.ts`:

- **Role-gated** — each family is visible only to roles that should see it (`VISIBILITY`).
- **De-identified** — cross-client aggregates (e.g. pricing comparables) show sectors and
  counts, never a single client's data.
- **Audited** — client-identifying reads by a firm-authorised user are logged.
- **Confidence as the throttle** — connected signals carry the same auditable confidence
  read and evidence trail as everything else; the feed's confidence filter still governs
  what surfaces.

## Phasing

1. **Read-only signals** *(demo today)* — connectors surface as evidence-backed cards,
   joined to the corpus. No writes, clearly labelled `· demo`.
2. **In-place actions** — draft the follow-up, nominate the resourcing fix, flag the deal —
   from the card, through the existing nomination → review gate.
3. **Write-back** — once trusted, push the outcome back (update the ClickUp stage, open the
   resourcing request), still audited and reversible.

---

## How the demo is wired

- Mock connector data: `workspace/connectors/{clickup,drive-resourcing,pricing}.json`.
- Mapping into the feed: `lib/signals/connected.ts` → assembled in `buildInbox`
  (`lib/signals/inbox.ts`) alongside the corpus families.
- In the UI, connected cards carry a `🔗 via … · demo` provenance chip and explain the
  join in their evidence panel.

Everything above the "demo today" line is **simulated** — the app has no live MCP
connection. The point is to make the connected future concrete and demonstrable, not to
imply it's shipped.
