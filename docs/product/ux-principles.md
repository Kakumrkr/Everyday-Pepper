# UX Principles

> **P1 (2026-10-26):** a complete redesign is planned for Phase 9 ([ADR-0044](../adr/0044-redesign-and-design-rules.md)). The enforced rules, copy rules and screen checklist are in [DESIGN.md](../design/DESIGN.md), which wins where this file differs. The tokens below stay in force until S40 replaces them.

**Direction:** warm and friendly (Airbnb-like): soft rounded shapes, generous spacing, friendly microcopy, real photography/illustration accents; calm, never cluttered. Working name **Pepper**. Design direction **approved 2026-10-16** (S1/S2 mockups: [`../mockups/README.md`](../mockups/README.md)); tokens below.

## Principles
1. **Mobile-first, one-thumb.** Owners use the app between clients. Primary actions reachable with one thumb; works great at 375 px width.
2. **Cards first, chat available** ([ADR-0043](../adr/0043-card-board-first-interaction.md)). Home is a board of one-tap decisions; every chat action has an equivalent screen; every screen has an "ask" entry.
3. **Cards, not walls of text.** AI responses render as typed cards: Booking, SlotPicker, ChangeDiff (before/after), ClientSummary, Suggestion, Confirmation, Undo toast.
4. **Show, then do.** For anything not set to "just do it", show exactly what will happen before it happens.
5. **Always reversible.** Undo is visible after every change; history shows who (person or AI) did what.
6. **Explain on demand.** "Why?" is one tap away, plain language, lists data used.
7. **Speak the business's language.** Terminology comes from the industry template (client/guest/member; stylist/therapist/trainer).
8. **Fast feels trustworthy.** Optimistic UI for safe actions; skeletons, not spinners; chat streams responses.
9. **Accessible.** WCAG 2.2 AA: contrast, focus states, screen-reader labels, reduced motion.
10. **Calm notifications.** Batch non-urgent items into the feed; push only for time-sensitive needs.

## Key screens (to mock up in Phase 0)
Operator feed (home) · Chat with cards · Calendar (day/week, per staff) · Client profile · "What I know" · Autonomy settings · Onboarding flow · Public booking page · Team & services.

## Approved design tokens (2026-10-16; Pepper green + chili accent since [PCR-002](../plan/changes/PCR-002.md), 2026-10-18)
Source of truth for `packages/ui`. The prototype `../mockups/pepper-prototype.html` uses exactly these values.

- **Type:** Bricolage Grotesque (display: headings, wordmark, big numbers) · Figtree (everything else, 15 px base). Always declare system fallbacks.
- **Mark:** chili-red speech bubble with a face and a green pepper stem. Wordmark: lowercase "pepper", Bricolage Grotesque ExtraBold.
- **Shape:** radius 10 / 16 / 24 px (sm / md / lg cards), pill buttons and chips, ≥ 44 px tap targets. Shadows only on floating elements.
- **Voice:** short, plain, first person. Say what happened and what didn't. No exclamation marks, emoji or system jargon.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` / `surface` / `surface-2` | `#F7FAF5` / `#FFFFFF` / `#EDF3EA` | `#0F1510` / `#172019` / `#202A22` | Backgrounds |
| `line` | `#DCE6D8` | `#2F3B31` | Borders |
| `ink` / `ink-2` | `#1B2A1E` / `#536257` | `#EAF3EA` / `#A7B7AA` | Text / secondary text |
| `brand` / `brand-strong` / `brand-soft` / `on-brand` | `#2A7230` / `#23652A` / `#E2F0E0` / `#FFFFFF` | `#86D28E` / `#97DB9E` / `#1B3320` / `#0A1F0D` | Pepper green: actions, links, selection |
| `accent` / `accent-soft` / `on-accent` | `#C2361B` / `#FDE6DF` / `#FFFFFF` | `#FF8C70` / `#3D1E16` / `#2A0B04` | Chili: the mark, Pepper's own voice (suggestions, briefing), highlights. **Never for status** |
| `ok` / `ok-soft` | `#0B6B63` / `#DDF1EE` | `#6BD5C6` / `#13322E` | Done (teal, so it never reads as the brand green) |
| `wait` / `wait-soft` | `#8F4C00` / `#FFEFD6` | `#FFC274` / `#3A2A12` | Needs your OK, sensitive warnings |
| `info` / `info-soft` | `#1D65A8` / `#E2EEFA` | `#8CC2F5` / `#172B3E` | Tips, settings notes |
| `danger` | `#9F1D2B` | `#FFB4AB` | Form errors, always with words (never color alone) |
| `s1`/`s1-ink`, `s2`/`s2-ink`, `s3`/`s3-ink` | `#E2F0DC`/`#2D5C25`, `#FDE4DB`/`#8A2D14`, `#FFEFC7`/`#7A4F00` | `#1E3519`/`#B5E3A8`, `#40211A`/`#FFC4B3`, `#3D3012`/`#FFDE8A` | Per-staff calendar colors (extend the set for larger teams) |
| `biz` / `biz-strong` / `biz-soft` / `biz-on` | derived from the tenant's brand color (sample `#7A3B8F` / `#6E3382` / `#F3E6F7` / `#FFFFFF`) | sample `#DDA6F0` / `#E5B6F5` / `#3A2244` / `#23102B` | Public booking page only (PCR-001) |

All text/background pairs must meet WCAG 2.2 AA (≥ 4.5:1) in both themes.

## Design system
`packages/ui`: tokens (color, type, spacing, radius, shadow) with light/dark themes, components built on accessible primitives (e.g. Radix) + Tailwind. Card components are shared between chat and screens. Built from S14 ([ADR-0019](../adr/0019-design-system-and-app-shell.md)): `packages/ui/src/tokens.ts` holds the values above, and a test checks them against AA.
