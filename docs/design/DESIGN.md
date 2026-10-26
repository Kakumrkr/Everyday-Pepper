# DESIGN.md: how Pepper looks, feels and reads

The design rules for every screen. Planning session P1 (2026-10-26) set them up ([ADR-0044](../adr/0044-redesign-and-design-rules.md), [V1 playbook](../plan/v1-playbook.md) Phase 9). Any session that changes a screen reads this file first.

**Status:** the rules (§5–§7) are in force from S39. The direction (§2–§4) is chosen by the user in **S39** and filled in then. Until S40 ships the new tokens, the old ones in `packages/ui/src/tokens.ts` stay (ADR-0019, PCR-002).

## 1. Who we design for

An owner-operator with 1–6 chairs (barber, hair, lash/brow, nails), on a phone, between clients, with 90 seconds and one free thumb. Second, their clients booking on a phone, often from Instagram. Staff third.

What they told us (simulated interviews, [readout](../research/interviews/2026-10-26-simulated-five-owners.md)): *"the booking page looks like a bank"*, *"one thumb, that's it"*, *"if I have to watch a tutorial I'm out"*.

## 2. Direction (chosen in S39)

**The brief for S39's three mockups:**
- **A · Warm boutique:** soft warm neutrals, rounded shapes, a confident accent, photography of real work, personality in the type. It should feel like a good salon.
- **B · Clean premium:** calm, generous white space, precise type, few colors, subtle depth. It should feel like Apple or Linear.
- **C · Bold modern** (the outside option): strong color fields, big numbers, energetic, like Cash App.

S39 uses `ui-ux-pro-max` for candidate systems and `frontend-design` for the mockups (playbook P1-14). This file decides over both. Each mockup shows the same five screens: Home card board, Calendar day, Client profile, the public booking page, and an approval card with "Why?" and Undo.

**What the user wants:** premium, distinctive, not a template. **What to avoid:** generic SaaS (grey cards on white, blue buttons), the cream + terracotta + serif look, gradients for decoration, emoji as icons, stock photos.

**Chosen:** _(S39 fills this in: the direction, what was mixed, and the user's words.)_

## 3. Tokens (S39 picks the values, S40 ships them)

The source of truth stays `packages/ui/src/tokens.ts`, mirrored in `theme.css` and kept equal by `theme.test.ts` (ADR-0019). S40 adds:

| Group | Tokens |
|---|---|
| Color | `bg`, `surface`, `surface-2`, `ink`, `ink-2`, `ink-3`, `line`, `brand`, `brand-ink`, `brand-soft`, `accent`, `ok`, `warn`, `danger`, `info` (each with `-soft`), light and dark |
| Type | display, title, heading, body, label, caption, number (tabular); sizes on a 1.2 scale from a 16 px body |
| Space | 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 |
| Radius | sm, md, lg, pill |
| Elevation | flat, raised (cards), floating (sheets, toasts) |
| Motion | fast 120 ms, base 180 ms, slow 240 ms; one easing curve; everything off under `prefers-reduced-motion` |

The booking page keeps the business's own brand color (PCR-001). Pepper's colors appear there only in the footer.

## 4. Components (S40 builds them in `packages/ui`)

Button (primary, secondary, quiet, danger; sm/md/lg), IconButton, Input, Select, Textarea, Checkbox, Switch, Sheet (bottom sheet on phones), Dialog, Tabs, Card, ListRow, Badge, Avatar, EmptyState, Skeleton, Toast, Stat (big number with a label). The AI cards (`packages/ui/src/cards`) are rebuilt from these. Radix primitives sit underneath where focus or overlay behaviour is needed. A dev-only gallery route shows every component in every state.

## 5. Rules, and how each one is enforced

| # | Rule | Enforced by |
|---|---|---|
| D1 | Colors only from tokens: no raw hex, `rgb()`, or Tailwind palette or arbitrary colors in `apps/web` and `packages/ui` | ESLint rule (S40); a failing build |
| D2 | Contrast ≥ 4.5:1 for text and ≥ 3:1 for icons and borders, in both themes | `theme.test.ts` (exists) |
| D3 | Tap targets ≥ 44 × 44 px; the main action within thumb reach at the bottom of the screen on phones | Playwright check at 375 px (S41) |
| D4 | One primary action per screen or sheet | Design review at `/session-close` |
| D5 | Every empty screen says what to do next, with the action ("Add your first service →") | Walkthrough at `/session-close`; component API (EmptyState needs an action) |
| D6 | Light and dark are equally finished | Screenshot tests at 375 / 412 / 1280 px × light / dark (S40 onwards) |
| D7 | Motion from the motion tokens only, ≤ 240 ms, off under reduced motion | Lint for raw durations; a Playwright reduced-motion check |
| D8 | Accessible: labels, focus rings, keyboard paths, landmarks, no information by color alone | axe in Playwright (exists); keyboard journeys |
| D9 | Skeletons, not spinners, for loads over 300 ms; optimistic UI for safe actions | Review |
| D10 | Numbers that matter (money, counts, times) use the tabular number style and the business's time zone | Review; existing time tests |
| D11 | Fonts self-hosted (Fontsource), no third-party requests | ADR-0019; build check |
| D12 | Phone first: design at 375 px, then widen; nothing scrolls sideways | Screenshot tests; an overflow check |

## 6. Copy rules

- **Voice:** short, plain, first person, warm. Say what happened and what didn't. No exclamation marks, no emoji, no system words (no "tenant", "entity", "sync failed", time zone ids).
- **Benefit first:** "Fill it and that's about $240 more today", not "It goes away when it's booked".
- **Name the consequence on every action card:** "Audy will get an email about the new time."
- **Errors say what to do:** "That time was just taken. Here are the next three."
- Terminology comes from the template (client, guest, stylist, barber).

## 7. The screen checklist (every UI session, at close)

- [ ] Walked as its user at 375 px, light and dark; screenshots in the PR
- [ ] One primary action; the next step is obvious
- [ ] Empty, loading, error and full states designed
- [ ] Copy read aloud: plain, kind, benefit first
- [ ] Keyboard and screen-reader labels checked; axe clean
- [ ] No raw colors, sizes or durations
