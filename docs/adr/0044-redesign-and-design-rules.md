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
3. **One design system, kept in `packages/ui`:** new tokens (color, type scale, spacing, radius, elevation, motion) and a component kit on Radix primitives. A dev-only gallery shows every component. The legacy stylesheet is deleted in S43.
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
- **Tokens:** `packages/ui/src/tokens.ts` and `theme.css` carry DESIGN.md §3 (colors, type scale as `type-*` utilities, radii incl. `xl` and `pill`, `shadow-raised`/`shadow-floating`, `motion-fast/base/slow` off under reduced motion, `ease-standard`). The old names (`on-brand`, `on-accent`, `brand-strong`, `wait`, `wait-soft`) stay as Tailwind aliases until S43; `s1`–`s3` are gone; the old `Card` is `LegacyCard`. `theme.test.ts` adds a 3:1 check for borders, focus rings and staff bars (`NON_TEXT_PAIRS`).
- **Kit:** 27 components in `packages/ui/src/kit/` (DESIGN.md §4), overlays on `@radix-ui/react-dialog`, `-tabs`, `-toggle-group`, `-toast`. Select, Checkbox and Switch are native inputs (the phone's own picker; forms work without script). Kit parts set their own background, padding and radius, since the legacy element styles in `globals.css` still apply until S43.
- **Lint:** `packages/config/eslint-design.js` (raw hex, color functions, Tailwind palette, black/white and arbitrary colors, Tailwind and inline durations) in the same `no-restricted-syntax` list as the raw-HTML rules; four exempt files (tokens, brand-color arithmetic, staff color choices, tests); stylesheets outside the theme checked by `eslint-design.test.js`.
- **Gallery:** `/dev/gallery`, only with `PEPPER_GALLERY=1` (CI's e2e run; 404 otherwise), on Southside Cuts' data. **Screenshots:** `e2e/tests/gallery.spec.ts`, 8 Linux baselines in `e2e/tests/__screenshots__/`, 1% pixel tolerance.

**S41 (2026-10-27):** the shell (bottom tabs Home · Calendar · Clients · Chat · More; a desktop sidebar with a "Pepper" and a "Business" group and Settings), a `/more` page that holds the places beyond the tabs, this device's notifications, the rebooking emails' address and the account (they left Home), Home, Chat and the AI cards on the kit. A card is raised only while it waits for a decision. Screenshots of Home, Chat and More (`screens.spec.ts`) and the D3 tap-target check (`tap-targets.ts`) run in Playwright.

**S42 (2026-10-28):** the Calendar day view, the Clients list and a client's profile on the kit. Staff tones (`brand`, `accent`, `info` soft blocks with a 4 px bar) come from a member's place among the active staff (`staffTone`), not the stored colour, which most share. The grid is 88 px an hour so a 30-minute booking is a 44 px target, and two staff columns fit 375 px. Empty states offer their next step as an action (AC-X-7). Screenshots of the three screens in `screens.spec.ts`, whose briefing no longer waits on the wall clock.

## Consequences
- Phase 9 adds five sessions before the old Phase 9 work. Each screen is redone once, before the new features land on it.
- Screenshot tests add baselines to the repo and a little time to CI. Baselines change only with a reviewed visual change.
- `docs/mockups/` (the S1 prototype) becomes history. S39's mockups replace it as the reference.

## Alternatives considered
- **Restyle screen by screen while building features:** no dedicated phase, but every feature session pays for two jobs, and the app looks inconsistent for months.
- **Adopt a ready UI kit (e.g. shadcn/ui) as is:** fast, but it is the template look the user dislikes. Its Radix base is used underneath instead.
