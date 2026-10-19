# ADR-0021: Setup screens: services, team, hours, time off, booking rules and clients

- **Status:** Accepted (user, 2026-10-19). Proposed by Claude the same day (S16), after the user said "give me the Session Brief, then continue". · **Date:** 2026-10-19 · Builds on ADR-0015 (base data), ADR-0016 (rules), ADR-0017 (clients, bookings), ADR-0018 (templates), ADR-0019 (design system), ADR-0020 (booking screens)

## Context
Phase 4 needs a new owner to set up the business in the app, without the api: the service menu, who can be booked with their hours, time off and services, the booking rules, and the clients. The api for services, staff, hours, time off and rules exists since S10–S11. Three things were missing:
- A way to **edit a client**. Clients could only be added.
- A **client's visits**. `GET /v1/bookings` could not filter by client.
- The **rule defaults in force**. Values a business does not set come from its industry template, else the platform (ADR-0016, ADR-0018). The template defaults lived only in the api, and the web app may not import `@pepper/templates`. So the rules screen could not say what "default" means.

## Decision
1. **Additive api changes.**
   - **`PUT /v1/clients/:clientId`** (`clients.manage`, owners and managers) replaces name, email and phone. It answers 404 `client_not_found` and 409 `client_email_taken`.
     - The new audit action `client.updated` records **only which details changed** (`{ changed: ['name' | 'email' | 'phone'] }`, `before: null`), never the values: they are personal data.
     - An edit that changes nothing writes nothing and is not audited.
     - Staff are refused by the route guard, the service and RLS (the clients `member_scope` WITH CHECK, unchanged).
   - **`clientId` on `GET /v1/bookings`** (optional). The 62-day range and the staff scope (AC-W9-1) still apply. A client profile asks twice: the 62 days before now and the 62 days after.
   - **`defaults` on `GET/PUT /v1/rules`.** These are the single-valued rules where neither the business nor a staff member sets one: the template's, else the platform's.
     - `getRuleDefaults` (appointments, `rules.read`) takes the template lookup from the app, like availability does.
     - Contracts now has one `RuleDefaultsSchema` (full, in `rules.ts`); the template schema is `TemplateRuleDefaultsSchema = RuleDefaultsSchema.partial()`.
2. **Screens** (`apps/web`, design system, Radix sheets from ADR-0020):
   - **Navigation.** Home · Calendar · Clients · Services · Team, each shown when the role has the read permission.
   - **Services** (`/services`).
     - The menu is grouped by category and shows duration, price ("from $65" or "$65–$80") and who offers each service.
     - Owners and managers add and edit services in a sheet: prices typed as dollars, sent as cents, and "Clients can book it" for active.
     - There is no delete: a service is made not bookable instead (ADR-0015).
   - **Booking rules** (`/services/rules`).
     - Fields: start-time grid, notice, how far ahead, a daily limit per staff member, and closed days (local dates).
     - Each value can stay on **Default (…)**, which shows the number in force.
     - The screen edits **business-wide rules only**. Staff members' own rules are sent back unchanged, because `PUT` replaces the whole set; the screen says how many there are.
     - Staff see the rules read-only.
   - **Team** (`/team`).
     - "Who can be booked" lists cards with colour, hours summary (e.g. `Mon–Fri 9:00 AM–5:00 PM`) and services. Each card opens the member's page.
     - "People with access" holds the Phase 2 roles, invites and leave, restyled on the design system with the same behaviour and accessible names.
     - **Add staff member** opens a sheet (name, colour, optional login link, services), then goes to the new member's page to set hours.
   - **Staff member** (`/team/:id`).
     - **Details:** owners and managers edit them; others see them read-only.
     - **Weekly hours:** owners and managers edit them. Each day is off or has one or more spans. Times are picked from 15-minute steps up to midnight, plus any stored time off that grid. The week is checked with `WeeklyHoursSchema` before it is sent.
     - **Time off:** whole days or part of one day, on the business's clock, converted to UTC in the browser. Owners and managers manage everyone's; staff only their own.
   - **Clients** (`/clients`, `/clients/:id`).
     - The list has a search by name or email. It is fetched from the browser, so the search text stays out of the page URL. Owners and managers see and add everyone; staff see their own clients.
     - The profile shows contact details, upcoming and recent visits (status for done, no-show and cancelled), **Edit details** for owners and managers, and **Book**, which opens the S15 sheet with the client already chosen.
   - **Pure helpers** in `apps/web/lib/setup.ts` are unit tested: money, durations, categories, the week and its summary, time choices, the time-off span and its label, the rule form, visits.

## Consequences
- A client profile shows at most four months of visits. Older history needs a paged "visits of a client" endpoint (later, with client memory in Phase 7).
- Per-staff rules exist in the api but have no screen yet; the rules screen keeps them. Add a per-staff section if owners ask for it.
- The Team list asks for each staff member's hours separately (at most 40). Fine for V1 team sizes; a batch endpoint can replace it.
- Times off the 15-minute grid (set through the api) are kept and shown, not rounded.
- The client edit audit says what changed, not to what. Restoring an old value needs the data itself, not the audit log, as with every client field.
- No delete anywhere on these screens (ADR-0015): services and staff members are made not bookable.

## Alternatives considered
- **A dedicated `GET /v1/clients/:id/bookings` endpoint with paging:** a better long-term shape, but more surface than this session needs. The `clientId` filter is a one-line, scope-preserving addition.
- **Importing `@pepper/templates` in the web app for the defaults:** breaks the layer rule (only the api imports templates) and would duplicate the merge with the platform defaults.
- **Editing per-staff rules on the rules screen now:** more UI for a case no pilot business has asked for yet.
- **`<input type="time">` for hours:** cannot show `24:00` (midnight at the end of the day), which the hours allow. Selects in 15-minute steps also work the same on every phone.
- **Search in the page URL (`/clients?q=`):** puts names and emails in web access logs and browser history.
