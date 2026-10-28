# DESIGN.md: how Pepper looks, feels and reads

The design rules for every screen. Planning session P1 (2026-10-26) set them up ([ADR-0044](../adr/0044-redesign-and-design-rules.md), [V1 playbook](../plan/v1-playbook.md) Phase 9). Any session that changes a screen reads this file first.

**Status:** the rules (§5–§7) are in force from S39. The direction (§2–§4) was chosen by the user in **S39: "A+B"** (warm boutique, with clean premium's calm on the busy screens). **S40 shipped the tokens, the kit (`packages/ui/src/kit/`), the gallery (`/dev/gallery` with `PEPPER_GALLERY=1`) and the lint** (ADR-0044 "Built"). **S41 moved the shell (bottom tabs, a sidebar with a Pepper group, More), Home, Chat and the AI cards onto the kit; S42 the Calendar day view, the Clients list and a client's profile; S42.2 the booking sheets, Services and Team (sheet actions in the footer, `SheetFooter`); S42.3 Autonomy, What I know and Waitlist (the Switch row one 44 px label); S43 the public pages (booking page, manage-booking, offer, unsubscribe) in the business's color, and saves confirmed by a kit Toast.** S43.2 moves auth and deletes the legacy stylesheet; until then sign-in, sign-up, MFA and create business use the old class names, which point at the new values.

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

**Chosen (S39, user, 2026-10-26): "A+B".** The user's words: *"I like A very good. and B is also very warm and good"*, then, after the A+B row, *"go with A+B"*. The reference is the A+B row of the [S39 canvas](../mockups/s39/README.md) (`docs/mockups/s39/canvas/M*.dc.html`).

- **From A (warm boutique):** the colors (plum and marigold on a warm off-white), Bricolage Grotesque for headings and big numbers, Figtree for text, pill buttons, the plum briefing block, rounded lifted cards, the bottom-sheet approval, the two-barber timeline.
- **From B (clean premium):** lists as rows with hairline dividers instead of a card per item, one big tabular number per screen, the labelled detail table (Time · Service · Who's told · Then), the step bar and the sticky bottom action bar on the booking page, the segmented switch (Both / Dre / Randy).
- **The one idea that ties them:** *a lifted card means "this needs you"*. Decision cards (briefing, approvals, offers) are raised; everything else (done items, overdue lists, visits, memory, services) is a quiet hairline row.
- **Color jobs:** plum `brand` is the primary action and Pepper's own mark; marigold `accent` is money and highlights (the "+$45" chip, the day's progress bar), never a button's text background on its own; status colors only for status. On the booking page the business's color replaces `brand` (PCR-001), and Pepper's plum appears only in the footer.
- Not taken: C (bold modern), and B's near-black-and-green palette.

## 3. Tokens (S39 picked the values, S40 ships them)

The source of truth stays `packages/ui/src/tokens.ts`, mirrored in `theme.css` and kept equal by `theme.test.ts` (ADR-0019). Every pair below passed the S39 contrast check (`docs/mockups/s39/contrast.py`, both themes); S40 moves the pairs into `TEXT_PAIRS`.

**Color** (light / dark)

| Token | Light | Dark | Job |
|---|---|---|---|
| `bg` | `#F6F1EC` | `#1A1418` | page |
| `surface` | `#FFFDFB` | `#241C21` | cards, sheets, bars |
| `surface-2` | `#EFE7DF` | `#2E242B` | wells, segmented track, photo placeholders |
| `ink` | `#2A1F26` | `#F5EDF1` | text |
| `ink-2` | `#5E4F58` | `#CDBFC7` | secondary text |
| `ink-3` | `#6F5E68` | `#A898A2` | hints, captions |
| `line` | `#E4D8CD` | `#3A2F36` | hairline dividers (decorative, no contrast minimum) |
| `line-strong` | `#8E7C86` | `#8A7A84` | input and control borders (3:1) |
| `brand` | `#5A2D52` | `#E0B3D6` | primary actions, the briefing block, current tab |
| `brand-ink` | `#FFFFFF` | `#2A1023` | text on `brand` |
| `brand-soft` | `#F0E2EC` | `#3B2737` | selected tab pill, quiet brand buttons, the owner's calendar blocks |
| `accent` | `#E8A33D` | `#F2B85A` | money chips, progress |
| `accent-ink` | `#2A1F26` | `#2A1F26` | text on `accent` |
| `accent-soft` | `#F8E7C8` | `#3D3018` | the second staff member's calendar blocks |
| `ok` / `ok-soft` | `#2F6B4F` / `#E3EFE7` | `#7FCBA4` / `#1F3A2D` | done, receipts |
| `warn` / `warn-soft` | `#8A5A00` / `#F7E9CC` | `#F0C26B` / `#3D3018` | overdue, at risk |
| `danger` / `danger-soft` | `#B3261E` / `#F6DEDB` | `#FF8A80` / `#3D1E1C` | errors, the "now" line |
| `info` / `info-soft` | `#2F5E8A` / `#E1EAF3` | `#9CC3E8` / `#1C2A38` | notices; the third staff member's blocks |
| `scrim` | `rgba(42,31,38,0.45)` | `rgba(0,0,0,0.6)` | behind sheets |

Staff colors (the old `s1`–`s3`) become `brand-soft`, `accent-soft` and `info-soft` with a 4 px left bar in `brand`, `accent` and `info`, by a member's place among the active staff (S42), so a booking's barber never depends on color alone (the name heads the column).

**Type.** Bricolage Grotesque (variable, opsz 12–96, 500–800) for display, titles and big numbers; Figtree (variable, 400–700; already in the app) for everything else. Both self-hosted through Fontsource (D11). Sizes on a 1.2 scale from a 16 px body, rounded:

| Style | Font | Size / line | Weight | Use |
|---|---|---|---|---|
| `number-xl` | Bricolage | 57 / 1.0, −0.04em | 700 | the one big number on a screen ($430) |
| `display` | Bricolage | 33 / 1.1, −0.02em | 700 | screen titles ("Morning, Dre", "Marcus Bell") |
| `title` | Bricolage | 28 / 1.15, −0.02em | 700 | sheet and receipt titles |
| `heading` | Bricolage | 23 / 1.2, −0.01em | 700 | section heads ("Needs your OK") |
| `subheading` | Figtree | 19 / 1.3 | 700 | card titles |
| `body` | Figtree | 16 / 1.45 | 400 | text |
| `label` | Figtree | 14 / 1.4 | 600 | buttons' small text, row meta, segmented options |
| `caption` | Figtree | 13 / 1.35 | 500 | sources ("Your note, Aug 11"), times in lists |
| `number` | either | any | any | `font-variant-numeric: tabular-nums` on every amount, count and time (D10) |

**Space** 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Screen gutter 20 px on phones; 12 px between cards, 16–24 px between sections.

**Radius** `sm` 12 (inputs' inner elements, small tiles), `md` 16 (inputs, time chips, wells), `lg` 24 (cards), `xl` 32 (the briefing block, sheet tops), `pill` 999 (buttons, chips, segmented controls, the tab pill).

**Elevation** `flat` (rows, wells); `raised` for decision cards only: light `0 1px 2px rgba(42,31,38,.06), 0 10px 28px rgba(42,31,38,.07)`, dark `0 1px 2px rgba(0,0,0,.5)` (dark lifts by `surface` instead); `floating` for sheets and toasts: light `0 -8px 32px rgba(42,31,38,.16)`, dark `0 -8px 32px rgba(0,0,0,.6)`.

**Motion** fast 120 ms (press, toggle), base 180 ms (expand Why?, chip select), slow 240 ms (sheets); one easing `cubic-bezier(0.2, 0, 0, 1)`; all off under `prefers-reduced-motion`.

**Sizes** tap targets ≥ 44 px (D3); primary buttons 48–54 px tall; the bottom tab bar 52 px items with a 52 × 30 px pill on the current tab.

The booking page keeps the business's own brand color (PCR-001); Pepper's colors appear there only in the footer.

## 4. Components (S40 builds them in `packages/ui`)

Button (primary pill in `brand`, secondary pill outlined in `line-strong`, quiet text button, danger; sm/md/lg), IconButton, Input, Select, Textarea, Checkbox, Switch (label and switch one 44 px row, the hint below), Sheet (bottom sheet on phones, `xl` top radius, `floating`), Dialog, Tabs, **Segmented** (pill track in `surface-2`, the selected option a raised `surface` pill), Card (**raised, only for something that needs a decision**), **ListRow** (hairline row: optional leading time or icon, title + meta, trailing amount or action, chevron when it navigates), **DetailTable** (`dl` with a label column and hairline rows: the approval card's Time · Service · Who's told · Then), Badge and **MoneyChip** (`accent` pill with tabular "+$45"), Avatar (initials on `brand-soft` or `accent`), EmptyState, Skeleton, Toast (a note on `ink` that goes by itself, or an error on `danger` that stays until dismissed; one provider in the signed-in shell, above the tabs on phones), **Receipt** (`ok-soft` strip with Undo), Stat (big number with a label; one `number-xl` per screen), **StepBar** (3 segments), **StickyActionBar** (summary + Back + primary at the bottom, D3), **TimeChip** (its look shared as `chipStyle` with filter chips), **BriefingBlock** (`brand` block with the day's number and progress), BottomTabBar (Home · Calendar · Clients · Chat · More, current tab in a `brand-soft` pill). The AI cards (`packages/ui/src/cards`) are rebuilt from these: ChangeCard = Card + DetailTable + Why? + Receipt. Radix primitives sit underneath where focus or overlay behaviour is needed. A dev-only gallery route shows every component in every state.

## 5. Rules, and how each one is enforced

| # | Rule | Enforced by |
|---|---|---|
| D1 | Colors only from tokens: no raw hex, `rgb()`, or Tailwind palette or arbitrary colors in `apps/web` and `packages/ui` | ESLint rule `packages/config/eslint-design.js` (S40), stylesheets by its test; a failing build |
| D2 | Contrast ≥ 4.5:1 for text and ≥ 3:1 for icons and borders, in both themes | `theme.test.ts` (`TEXT_PAIRS`, `NON_TEXT_PAIRS` from S40) |
| D3 | Tap targets ≥ 44 × 44 px; the main action within thumb reach at the bottom of the screen on phones | Playwright check at 375 px: `e2e/tests/tap-targets.ts` in `shell.spec.ts` (S41) and `screens.spec.ts` (S42: Calendar, Clients, profile; S42.2: Services, rules, Team, a staff member and five open sheets, each sheet's main action at the bottom; S42.3: Autonomy with its switch and dial, What I know, Waitlist; S43: the booking page at every step with its sticky action at the bottom, manage-booking, the offer and unsubscribe links, Autonomy with its saved toast; S43.2 adds auth) |
| D4 | One primary action per screen or sheet | Design review at `/session-close` |
| D5 | Every empty screen says what to do next, with the action ("Add your first service →") | Walkthrough at `/session-close`; component API (EmptyState needs an action) |
| D6 | Light and dark are equally finished | Screenshot tests at 375 / 412 / 1280 px × light / dark (`e2e/tests/gallery.spec.ts` from S40; `screens.spec.ts` from S41: Home, Chat, More; S42: Calendar, Clients, a profile; S42.2: Services, Team, a staff member, the booking and new-booking sheets; S42.3: Autonomy, What I know empty and with facts, Waitlist empty; S43: the booking page's seven steps, manage-booking, the offer and unsubscribe links) |
| D7 | Motion from the motion tokens only, ≤ 240 ms, off under reduced motion | Lint for raw durations (S40); `theme.test.ts` checks the tokens drop to 0 under reduced motion |
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
