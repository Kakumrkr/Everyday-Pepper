# ADR-0044: A complete redesign, and design rules enforced by tests

- **Status:** Accepted (the plan and the rules). Approved by the user in planning session P1 on 2026-10-26. The **Direction** section below is filled in when the user picks a direction in S39.
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
_(S39: the chosen direction, what was mixed, the user's words, and the token values. PCR-002's colors are superseded from S40 if the pick changes them.)_

## Consequences
- Phase 9 adds five sessions before the old Phase 9 work. Each screen is redone once, before the new features land on it.
- Screenshot tests add baselines to the repo and a little time to CI. Baselines change only with a reviewed visual change.
- `docs/mockups/` (the S1 prototype) becomes history. S39's mockups replace it as the reference.

## Alternatives considered
- **Restyle screen by screen while building features:** no dedicated phase, but every feature session pays for two jobs, and the app looks inconsistent for months.
- **Adopt a ready UI kit (e.g. shadcn/ui) as is:** fast, but it is the template look the user dislikes. Its Radix base is used underneath instead.
