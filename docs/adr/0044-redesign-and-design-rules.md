# ADR-0044: A complete redesign, and design rules enforced by tests

- **Status:** Accepted (the plan and the rules). Approved by the user in planning session P1 on 2026-10-26. The **Direction** section was filled in S39 (the user chose "A+B", 2026-10-26).
- **Date:** 2026-10-26
- **Builds on:** ADR-0019 (design system and app shell), PCR-001 (the business's brand color on the booking page), PCR-002 (Pepper green + chili); [V1 playbook](../plan/v1-playbook.md) Phase 9; [PCR-007](../plan/changes/PCR-007.md)

## Context
The user does not like how the app looks: bland, template-like, not premium. The product sells to beauty businesses, where the look of a booking page changes what clients will pay ("$95 for a highlight, not $65" in the simulated interviews). The review scored friendly UX and mobile at 6.

The look is already central. Every color, radius and font lives in `packages/ui/src/tokens.ts` and `theme.css`, kept equal by a test that also checks contrast (ADR-0019). Screens use Tailwind utilities on those tokens, plus one legacy stylesheet for the early forms.

## Decision
1. **Redesign before building new screens** (Phase 9, S39–S43), so Phases 10–17 build in the new look once.
2. **The direction is chosen from clickable mockups** (S39): three directions (warm boutique, clean premium, bold modern) over the same five screens. The user picks or mixes. Nothing is coded before the pick.
3. **One design system, kept in `packages/ui`:** new tokens (color, type scale, spacing, radius, elevation, motion) and a component kit on Radix primitives. A dev-only gallery shows every component. The legacy stylesheet is deleted in S43.2 (split from S43, PCR-008).
4. **The rules in [DESIGN.md](../design/DESIGN.md) §5 are enforced by tooling, not memory:**
   - a lint rule against raw colors and durations;
   - the existing contrast test;
   - Playwright screenshot tests at 375 / 412 / 1280 px in light and dark;
   - a tap-target check;
   - axe, which exists already.
5. **What stays:** Tailwind v4 CSS-first, self-hosted fonts, the business's brand color on the booking page (PCR-001), light and dark themes.
6. **Visual change needs a reason.** A screenshot difference fails CI until the baseline is updated in the same PR, with the screenshots shown in the PR.

## Direction
**Chosen in S39 (user, 2026-10-26): "A+B"**, warm boutique with clean premium's calm on the busy screens. The user, after the three directions: *"I like A very good. and B is also very warm and good. what is your rec?"*; Claude recommended A as the base with B's list and table patterns and built an A+B row of the same five screens; the user: *"go with A+B"*.

- **Mixed:** A's colors (plum `#5A2D52` and marigold `#E8A33D` on `#F6F1EC`; dark `#E0B3D6` / `#F2B85A` on `#1A1418`), type (Bricolage Grotesque + Figtree), pill buttons, briefing block and bottom sheets; B's hairline lists, one big tabular number per screen, the labelled detail table on approvals, the booking page's step bar and sticky action bar, the segmented switch. A raised card means "this needs you"; everything else is a quiet row.
- **Not taken:** C (bold modern), and B's near-black-and-green palette. The `ui-ux-pro-max` candidate systems (pink + lavender, black + gold, gold + purple) were input only.
- **Values:** the full token table, type scale and component list are in [DESIGN.md](../design/DESIGN.md) §2–4; every color pair passed the contrast check (`docs/mockups/s39/contrast.py`) in both themes.
- **Supersedes PCR-002's colors from S40** (Pepper green + chili). The staff tints `s1`–`s3` become `brand-soft`, `accent-soft`, `info-soft` with a colored left bar. Bricolage Grotesque is added through Fontsource beside Figtree (D11); S40 checked both packages: `@fontsource-variable/bricolage-grotesque` and `-figtree` 5.3.0, both OFL-1.1, already installed in S14.
- **Reference:** the A+B row of the S39 canvas (sources in `docs/mockups/s39/`).

## Built (S40, 2026-10-27)
- **Tokens:** `packages/ui/src/tokens.ts` and `theme.css` carry DESIGN.md §3 (colors, type scale as `type-*` utilities, radii incl. `xl` and `pill`, `shadow-raised`/`shadow-floating`, `motion-fast/base/slow` off under reduced motion, `ease-standard`). The old names (`on-brand`, `on-accent`, `brand-strong`, `wait`, `wait-soft`) stay as Tailwind aliases until S43.2; `s1`–`s3` are gone; the old `Card` is `LegacyCard`. `theme.test.ts` adds a 3:1 check for borders, focus rings and staff bars (`NON_TEXT_PAIRS`).
- **Kit:** 27 components in `packages/ui/src/kit/` (DESIGN.md §4), overlays on `@radix-ui/react-dialog`, `-tabs`, `-toggle-group`, `-toast`. Select, Checkbox and Switch are native inputs (the phone's own picker; forms work without script). Kit parts set their own background, padding and radius, since the legacy element styles in `globals.css` still apply until S43.2.
- **Lint:** `packages/config/eslint-design.js` (raw hex, color functions, Tailwind palette, black/white and arbitrary colors, Tailwind and inline durations) in the same `no-restricted-syntax` list as the raw-HTML rules; four exempt files (tokens, brand-color arithmetic, the stored staff color, tests); stylesheets outside the theme checked by `eslint-design.test.js`.
- **Gallery:** `/dev/gallery`, only with `PEPPER_GALLERY=1` (CI's e2e run; 404 otherwise), on Southside Cuts' data. **Screenshots:** `e2e/tests/gallery.spec.ts`, 8 Linux baselines in `e2e/tests/__screenshots__/`, 1% pixel tolerance.

**S41 (2026-10-27):** the shell (bottom tabs Home · Calendar · Clients · Chat · More; a desktop sidebar with a "Pepper" and a "Business" group and Settings), a `/more` page that holds the places beyond the tabs, this device's notifications, the rebooking emails' address and the account (they left Home), Home, Chat and the AI cards on the kit. A card is raised only while it waits for a decision. Screenshots of Home, Chat and More (`screens.spec.ts`) and the D3 tap-target check (`tap-targets.ts`) run in Playwright.

**S42 (2026-10-28):** the Calendar day view, the Clients list and a client's profile on the kit. Staff tones (`brand`, `accent`, `info` soft blocks with a 4 px bar) come from a member's place among the active staff (`staffTone`), not the stored colour, which most share. The grid is 88 px an hour so a 30-minute booking is a 44 px target, and two staff columns fit 375 px. Empty states offer their next step as an action (AC-X-7). Screenshots of the three screens in `screens.spec.ts`, whose briefing no longer waits on the wall clock.

**S42.2 (2026-10-28):** the booking and new-booking sheets, Services (with its editor and the booking rules) and Team (the list, a staff member's page, the staff sheet) on the kit; the old local sheet is gone. A sheet's actions go in its footer through the kit's `SheetFooter`, which a form inside the body uses while keeping its own state (submit buttons name their form; outside a sheet it renders in place, inside a Dialog it stays in the dialog), with the form's error line beside them. The Team colour picker and its seven-colour palette are gone (D-2): a member's tone is their place among the active staff everywhere (`activeStaffTone`), and the stored colour is only sent back. The kit Checkbox's label wraps its box, so the whole row is the 44 px target; a Sheet whose `returnFocus` finds nothing gives focus to its trigger. Screenshots of Services, Team, a staff member and both booking sheets; at 375 px the tap targets of each screen and open sheet, and the main action at the bottom of the phone (AC-X-9).

**S42.3 (2026-10-28):** Autonomy, What I know and Waitlist on the kit, so every signed-in screen is on it (public pages and auth follow in S43). The kit Switch's label and switch are one `<label>`, so the row is one 44 px target; its hint sits below, outside the label, so reading it never flips a setting (the review's finding: a tap on a long hint paused learning for the whole business). The autonomy dial stays a radio group on tokens (D-2: the kit Segmented is a toggle group without a locked option). Pressable chips share the kit's `chipStyle` (TimeChip and What I know's filters). An empty memory offers "Tell Pepper in chat", an empty waitlist "Add someone in chat", no offers yet a secondary "Open the calendar" (one primary per screen, D4). Screenshots of the three screens (memory empty and with facts, waitlist empty) and their tap targets at 375 px (AC-X-10).

**S43 (2026-10-28):** the public pages on the kit, in the business's own color (`.bookpage`, PCR-001): the booking page (the kit StepBar, services and staff as hairline rows that each move the booking on with one tap, times as chips in three columns, kit Inputs, "Send my code" and "Confirm booking" in a StickyActionBar at the bottom of the phone, a DetailTable once booked), manage-booking (a danger button to cancel), the offer page and unsubscribe (a kit Card: it asks for a decision). The page's clock is named by its city ("Times are Chicago time", no zone id, DESIGN §6). `LegacyCard` and `buttonClass` are deleted; `chipClass`, the old aliases and the legacy stylesheet go with auth in S43.2 (D-1 split). The kit Toast gains `tone="error"` (announced at once, stays until dismissed) and `duration`; the signed-in shell has one `ToastProvider`, and Autonomy confirms each save with a toast above the tabs instead of a line at the bottom of a long page (the S42.3 retro's top-up). Screenshots of every public step and tap targets at 375 px (AC-X-11).
- Phase 9 adds five sessions before the old Phase 9 work. Each screen is redone once, before the new features land on it.
- Screenshot tests add baselines to the repo and a little time to CI. Baselines change only with a reviewed visual change.
- `docs/mockups/` (the S1 prototype) becomes history. S39's mockups replace it as the reference.

## Alternatives considered
- **Restyle screen by screen while building features:** no dedicated phase, but every feature session pays for two jobs, and the app looks inconsistent for months.
- **Adopt a ready UI kit (e.g. shadcn/ui) as is:** fast, but it is the template look the user dislikes. Its Radix base is used underneath instead.
