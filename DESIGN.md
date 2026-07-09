# Design standard

The bar: **shipped UI is held to the same quality as the design prototypes.** This app was
built incrementally, so styling drifted — each feature grew its own CSS. This document is the
antidote. Design against the shared token system below; don't invent one-off values. When adding
or changing UI, treat _"does this match the prototype's polish?"_ as a real acceptance criterion.

Reference prototype: the Interrogate redesign artifact (evidence-first, auditable confidence).

---

## 1. Tokens are the system

All colour, type, radius, and elevation live as CSS custom properties in
[`app/globals.css`](app/globals.css) under `:root`. **Refine values there once; the whole app
moves with them.** Never hard-code a hex, a radius, or a shadow in a component — reach for a token.

| Token | Role |
| --- | --- |
| `--bg` | page ground (warm off-white) |
| `--surface` / `--panel` | card / panel surface |
| `--surface-2` | raised or inset warm panel (headers, wells) |
| `--hair` / `--border`, `--hair-2` | hairline borders (outer, softer inner) |
| `--ink`, `--ink-2` / `--muted`, `--ink-3` | text: primary · secondary · faint |
| `--accent`, `--accent-soft` | terracotta — **reserved for "opportunity / win work"** |
| `--risk`, `--risk-soft` | delivery risk / red flags |
| `--delivery`, `--delivery-soft` | delivery-health / positioning / external-web |
| `--good`, `--good-soft` | confirmed / passed a check |
| `--mono` | the monospace "data & evidence" voice |
| `--r-sm`, `--r`, `--r-lg` | radii | 
| `--shadow` | card elevation |

Legacy names (`--panel`, `--border`, `--muted`) are kept as aliases so existing rules keep
working. New components should prefer the semantic names (`--surface`, `--hair`, `--ink-2`).

## 2. Principles

1. **Neutrals are warm and chosen, not flat grey.** They carry a slight bias toward the terracotta
   accent. A pure mid-grey reads as unconsidered.
2. **The accent is spent in one place.** Terracotta means _opportunity / the thing that wins work_.
   Signal _kind_ (risk, delivery, positioning) uses the semantic hues — never the accent. Semantic
   colour is not the accent.
3. **Monospace is the voice of data and evidence.** Confidence meters, source counts, provenance,
   timestamps, pipeline traces, labels → `--mono`. This is what makes the product read as _rigorous
   instrument_, not generic AI. Prose stays in the sans stack.
4. **Confidence is a measured, visible scale** (e.g. `●●●●○`), and where possible **auditable** —
   show _why_ a rating was earned, not just the number.
5. **Provenance is first-class.** Claims trace to their source (document · date · internal/external),
   ideally verbatim. This is the trust mechanism, not a footnote.
6. **Layout does the spacing.** Flex/grid + `gap`, not per-element margins. Wide content
   (tables, code, diagrams) scrolls inside its own `overflow-x: auto` container.
7. **One warm light theme, on purpose.** The product commits to a single considered light identity.
   If dark mode is ever added, do it at the token level, not per-component.
8. **Copy is design material.** Name things by what the user recognises; controls say exactly what
   they do; specific beats clever.

## 3. Reusable patterns

Established on the Interrogate work; reuse rather than re-style.

- **Card** — `--surface`, `1px solid --hair`, `--r-lg`, `--shadow`.
- **Confidence meter** — `--mono`, filled/empty dots (`●●●●○`) in `--ink`, with a text label.
- **Kind pill** — `--mono`, uppercase, tiny; `*-soft` background + solid hue text (`opp`/`risk`/`deliv`).
- **Evidence trail** — a kind label column (`Internal` · `Pattern` · `🌐 Web`) + provenance line
  (document · date · open-source link) + verbatim quote in italic `--ink-2`.
- **Counter-check** — a `--good`-bordered well: what was tested against / what would change the finding.

## 4. Checklist before shipping UI

- [ ] Every colour, radius, shadow comes from a token — no stray hexes.
- [ ] Accent used only for "opportunity"; signal kind uses semantic hues.
- [ ] Data/labels/evidence in `--mono`; prose in the sans stack.
- [ ] Type hierarchy is deliberate; spacing comes from `gap`.
- [ ] Interactive things look interactive; focus states are visible.
- [ ] Matches the prototype's polish. If not, say why.
