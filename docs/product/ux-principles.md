# UX Principles

**Direction:** warm and friendly (Airbnb-like): soft rounded shapes, generous spacing, friendly microcopy, real photography/illustration accents; calm, never cluttered. Working name **Floty**. Design direction **approved 2026-10-16** (S1/S2 mockups: [`../mockups/README.md`](../mockups/README.md)); tokens below.

## Principles
1. **Mobile-first, one-thumb.** Owners use the app between clients. Primary actions reachable with one thumb; works great at 375 px width.
2. **Conversation first, UI always available.** Every chat action has an equivalent screen; every screen has an "ask" entry.
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

## Approved design tokens (2026-10-16)
Source of truth for `packages/ui`. The prototype `../mockups/floty-prototype.html` uses exactly these values.

- **Type:** Bricolage Grotesque (display: headings, wordmark, big numbers) · Figtree (everything else, 15 px base). Always declare system fallbacks.
- **Mark:** speech bubble with a face. Wordmark: lowercase "floty", Bricolage Grotesque ExtraBold.
- **Shape:** radius 10 / 16 / 24 px (sm / md / lg cards), pill buttons and chips, ≥ 44 px tap targets. Shadows only on floating elements.
- **Voice:** short, plain, first person. Say what happened and what didn't. No exclamation marks, emoji or system jargon.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` / `surface` / `surface-2` | `#FFF8F7` / `#FFFFFF` / `#FBEEEC` | `#161015` / `#211820` / `#2B2029` | Backgrounds |
| `line` | `#EEDCD9` | `#3B2D38` | Borders |
| `ink` / `ink-2` | `#2B1B24` / `#6A5560` | `#F8ECF1` / `#BDA8B3` | Text / secondary text |
| `brand` / `brand-strong` / `brand-soft` / `on-brand` | `#BE2759` / `#B01F52` / `#FDE5ED` / `#FFFFFF` | `#FF7FA8` / `#FF8FB3` / `#46202F` / `#2A0D19` | Raspberry: actions, links, selection |
| `ok` / `ok-soft` | `#23703A` / `#E2F2E5` | `#7FD69A` / `#1D3324` | Done |
| `wait` / `wait-soft` | `#8F4C00` / `#FFEFD6` | `#FFC274` / `#3A2A12` | Needs your OK, sensitive warnings |
| `info` / `info-soft` | `#1D65A8` / `#E2EEFA` | `#8CC2F5` / `#172B3E` | Tips, settings notes |
| `danger` | `#B3261E` | `#FFB4AB` | Form errors |
| `s1`/`s1-ink`, `s2`/`s2-ink`, `s3`/`s3-ink` | `#FCE3EC`/`#8E1D47`, `#DAF2EB`/`#0D5E4F`, `#FFEFC7`/`#7A4F00` | `#4A2032`/`#FFC2D6`, `#173A33`/`#A6EBD9`, `#3D3012`/`#FFDE8A` | Per-staff calendar colors (extend the set for larger teams) |
| `biz` / `biz-strong` / `biz-soft` / `biz-on` | derived from the tenant's brand color (sample `#0E6656` / `#0D5E4F` / `#DAF2EB` / `#FFFFFF`) | sample `#6FD9C0` / `#7FE0C9` / `#173A33` / `#062019` | Public booking page only (PCR-001) |

All text/background pairs must meet WCAG 2.2 AA (≥ 4.5:1) in both themes.

## Design system
`packages/ui`: tokens (color, type, spacing, radius, shadow) with light/dark themes, components built on accessible primitives (e.g. Radix) + Tailwind. Card components are shared between chat and screens.
