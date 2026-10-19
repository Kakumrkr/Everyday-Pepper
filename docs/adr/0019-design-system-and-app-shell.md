# ADR-0019: Design system, app shell and the calendar's data

- **Status:** Proposed (Claude, 2026-10-18, S14). The user asked for the session to go ahead after the Session Brief without waiting, so every choice below is Claude's recommendation for the user to accept or change in the PR. · **Date:** 2026-10-18 · Builds on the approved design tokens (`product/ux-principles.md`, S1/S2), ADR-0016 (time zones), ADR-0017 (bookings, busy times) and the S13 security review

## Context
Phase 4 starts the owner and staff screens. The approved plan says `packages/ui` holds the tokens (light and dark) and components "built on accessible primitives (e.g. Radix) + Tailwind". Until now the web app had one hand-written stylesheet with some of the tokens. The calendar is the first screen on the S10–S12 api. It needs the business's wall clock in the browser's server code, which until now lived only in the appointments module. The S13 security review also left the list endpoints without a response cap.

## Decision
1. **`packages/ui` (`@pepper/ui`)**, imported only by apps (lint already allowed `ui → contracts`; `apps/web → ui`).
   - `src/tokens.ts` is the source of truth: every color token as `[light, dark]`, the radii, the 44 px tap target and the 960 px desktop width, plus `contrastRatio`/`luminance` (WCAG 2.2).
   - `src/theme.css` carries the same values as CSS variables (`--bg`, `--ink`, …), switched by `prefers-color-scheme`, and maps them to Tailwind colors (`bg-surface`, `text-ink-2`, `bg-brand-soft`, …), the fonts (`font-sans`, `font-display`), the radii and a `desk:` breakpoint (60 rem = 960 px).
   - A test keeps `theme.css` equal to `tokens.ts` and checks every text/background pair the screens use against 4.5:1 in both themes.
   - Components are small and server-renderable: `Logo`/`Mark`, `Icon` (the prototype's line icons), `Card`; `buttonClass`/`chipClass` give links and buttons the same look. Radix comes in when a screen needs a dialog, menu or popover (S15's booking sheet), not before.
2. **Tailwind v4, CSS-first** (no `tailwind.config`): `apps/web/app/globals.css` imports `tailwindcss` and `@pepper/ui/theme.css` and scans `packages/ui/src`. The Phase 2 stylesheet stays for the forms it styles, moved into `@layer base` so utilities always win, and its card layout now applies only to pages outside the shell (`body > main`). Screens move to utilities as they are rebuilt.
3. **Fonts are self-hosted** through Fontsource (`@fontsource-variable/figtree`, `@fontsource-variable/bricolage-grotesque`): no request to Google at build or run time, so offline and Docker builds work and visitors' addresses are not sent to a third party. Tailwind and the fonts are build-time (dev) dependencies; the standalone server does not need them.
4. **App shell: a route group `app/(app)`** with one layout for the signed-in screens (Home, Calendar, Team). Bottom tabs on phones, a sidebar from 960 px. Only one of the two is displayed, so each place has one link in the accessibility tree. The layout sends people with a step left (sign in, create a business, two-step) there, as the pages did. `currentAccount`/`currentBusiness` are cached per request (React `cache`), so layout and page share one api call each. Navigation shows Calendar only with `calendar.read`; the api still checks everything.
5. **The time-zone helpers move to contracts** (`zoned-time.ts`: `toZoned`, `fromZoned`, `addDays`, …). They are pure (`Intl` only). The appointments module re-exports them, so the engine and its tests are unchanged, and the web app uses the same conversion (L4 apps may import contracts, not modules).
6. **Calendar day view, read-only (S14).**
   - `?date=YYYY-MM-DD&staff=<id>`; a bad date falls back to today on the business's clock, and a bad id falls back to everyone.
   - One column per active staff member, or only the chosen one. The grid is 8 am – 8 pm and widens to whole hours to fit. Positions are wall-clock minutes, so on a clock-change day 10 am stays on the 10 am line. Items crossing midnight are clipped to the day.
   - What each column shows follows the api's own scope (AC-W9-1). Owners and managers see every booking in full. Staff see their own staff member's bookings in full and colleagues' as "Busy" (`GET /v1/calendar/busy`, no details).
   - Client names come from `GET /v1/clients/:id`, one request per distinct client of the day, at most 60 (`MAX_CLIENT_LOOKUPS`; others show "Client"). This avoids a new endpoint until the client screens (S16) need a batch lookup.
   - Cancelled bookings are not drawn. Completed and no-show bookings carry a label; overridden ones say "Outside the usual hours".
7. **Response caps (S13 review finding).** `GET /v1/bookings`, `/v1/calendar/busy` and `/v1/availability` return at most `MAX_LIST_ITEMS` (500), earliest first, with `truncated: true` when more exist. Repositories and services take an optional `limit`, and the api asks for one more than the cap. The responses' new `truncated` field is additive. The calendar tells the user when a day was cut and suggests filtering by staff member.

## Consequences
- New screens are built from tokens and utilities; a color outside the token set needs a token (and passes the contrast test) first.
- The legacy stylesheet shrinks as the Phase 2 screens are redone; nothing new should be added to it.
- A day with more than 500 appointments in the business is shown incomplete, with a notice. Busy times and availability follow the same rule. A caller that needs everything asks again with `from` set to the last item's start and skips what it already has, as the AI tools will in Phase 6.
- Per-client lookups cost one api call each (at most 60 per day view). S16 replaces them with a batch lookup if the client screens need one anyway.
- Docker image builds could not run in the Claude Code sandbox (its proxy breaks TLS inside `docker build`). The Playwright journeys ran against the apps started with `pnpm` and the Compose infrastructure; CI builds the images.

## Alternatives considered
- **Plain CSS modules, no Tailwind:** fewer dependencies, but it departs from the approved plan (a PCR) and duplicates the spacing and state utilities Tailwind gives for free.
- **`next/font/google`:** downloads fonts during the build, which fails offline and in restricted networks; Fontsource gives the same files from npm.
- **Pagination with cursors on the three list endpoints:** more than the calendar needs now. The cap with `truncated` is enough to bound the answer, and cursors can be added without breaking callers.
- **A batch `GET /v1/clients?ids=` now:** a contract and api change only the calendar would use today. It is deferred to the client screens.
