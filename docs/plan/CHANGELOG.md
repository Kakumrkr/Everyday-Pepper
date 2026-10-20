# Plan Changelog

Plan versions use `MAJOR.MINOR`: MINOR for approved PCRs that keep compatibility; MAJOR for scope or architecture changes.

## 0.15 — 2026-10-20
- S19 (Phase 5a): [ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md) (accepted by the user; its five decisions were chosen at the S19 Session Brief): the transactional outbox (`outbox_messages` with RLS, the `outbox_dispatch` index read through the read-only `outbox_scan` policy), content sealed with AES-256-GCM under a new required `OUTBOX_SECRET` (api and worker), delivery in the worker through BullMQ 6.3.11 with a lease, retries in Postgres and an alert when a message is given up. The booking page's confirmed/moved/cancelled emails move onto it (ends the temporary exception of 0.13); the code email stays direct. The SMTP mailer moves from the api to `@pepper/runtime`. **D4 resolved: Resend for the pilot.** Phase 5 split: S19 outbox, S20 confirmations for team-made bookings, reminders (AC-W6-1) and expired-request cleanup, S21 tasks and push notifications. No change to scope, contracts' existing shapes or exit criteria.

## 0.14 — 2026-10-20
- S18 (Phase 4e): [ADR-0023](../adr/0023-pwa-offline-and-phase-4-exit.md) (accepted by the user): an installable app (manifest, icons) with a hand-written service worker that caches only a static offline page, linked from the signed-in app only; security headers on every web response and `no-store` on forwarded api answers (the two medium findings of the [Phase 4 security review](../engineering/security-review-s18.md); no high ones); axe in Playwright on the key screens (`@axe-core/playwright` 4.13.0, e2e only); AC-W8-1 in Playwright. **Phase 4 complete.** No change to phases, scope, contracts or exit criteria.

## 0.13 — 2026-10-20
- S17 (Phase 4d): [ADR-0022](../adr/0022-public-booking-page.md) (accepted by the user): public booking page with email verification. Implements PCR-001 (brand color, AA-adjusted tokens). Additive changes: `tenants.brand_color`, `booking_verifications`, `bookings.manage_token_hash`, the read-only `public_lookup` policy, `/v1/public/businesses/:slug/*`, `PUT /v1/tenant/booking-page`, audit action `tenant.updated`, new error codes. A dev SMTP sender (nodemailer → Mailpit) is used directly by the api until Phase 5's outbox (a temporary exception to "side effects through the outbox", recorded in the ADR). No change to phases, scope or exit criteria.

## 0.12 — 2026-10-19
- S16 (Phase 4c): [ADR-0021](../adr/0021-setup-screens.md) (accepted by the user): Services and booking rules, Team with staff pages (details, weekly hours, time off), Clients list and profile, Team screen on the design system. Additive api changes: `PUT /v1/clients/:clientId` (audit `client.updated` with only the changed field names), `clientId` filter on `GET /v1/bookings`, `defaults` on `GET/PUT /v1/rules` (contracts: one `RuleDefaultsSchema`; the template schema is renamed `TemplateRuleDefaultsSchema`). No change to phases, scope or exit criteria.

## 0.11 — 2026-10-19
- S15 (Phase 4b): [ADR-0020](../adr/0020-booking-screens-and-client-lookup.md) (accepted by the user): booking screens on the calendar (new booking, booking sheet, alternatives, waitlist), with Radix Dialog as planned. Implements two earlier decisions: staff find any client by exact email or phone (user, 2026-10-17; migration 0020 widens the clients read policy for that exact contact only; `POST /v1/clients/lookup`; optional `clientContact` on bookings and waitlist entries, additive), and outcomes rule (b): `completed`/`no_show` final for staff, correctable by owners and managers (Claude's recommendation, built by default because open question 1 was still unanswered). No change to phases, scope or exit criteria.

## 0.10 — 2026-10-18
- [PCR-002](changes/PCR-002.md): the product is renamed from **Floty** to **Pepper** everywhere (UI, docs, mockup, `@pepper/*` packages, database roles and names, cookies, telemetry), and the theme is **Pepper green + chili accent** (new `accent` tokens; "done" teal; plum sample business). No change to phases, scope or exit criteria.

## 0.9 — 2026-10-18
- S13 (Phase 3d): [ADR-0018](../adr/0018-industry-templates.md) accepted; **Phase 3 complete**.
- Session plan: Phase 4 split into **S14** (design system, app shell, calendar day view), **S15** (booking screens), **S16** (clients, services, team screens), **S17** (public booking page + email verification), **S18** (Phase 4 exit). Proposed by Claude at S14, which the user asked to go ahead with. No change to phases, scope or exit criteria.
- S14 (Phase 4a): [ADR-0019](../adr/0019-design-system-and-app-shell.md) (proposed): `@pepper/ui` with Tailwind v4 as planned, self-hosted fonts, the app shell, time-zone helpers shared through contracts, and a 500-item cap with `truncated` on the bookings, busy-time and availability answers (additive contract change, closes the S13 finding).

## 0.8 — 2026-10-17
- S12 (Phase 3c): [ADR-0017](../adr/0017-bookings-clients-and-waitlist.md) (accepted by the user): bookings with a `booking_occupancy` exclusion constraint (buffers included), staff-scoped RLS (AC-W9-1), statuses `confirmed`/`completed`/`no_show`/`cancelled`, owner/manager override, alternatives for refused times, idempotency keys; a minimal `clients` table in core; the waitlist model and API. Decided by the user at the S12 Session Brief: clients table now, occupancy table, no "pending", the override, the waitlist window format and its API. Data model: "Customer" is named "client" (as the permissions and UI already were), and booking sources `owner`/`staff` became `team`. No change to phases, scope or exit criteria. After S12 the user chose: staff may find any client by exact email or phone (built in Phase 4); staff still cannot add clients.

## 0.7 — 2026-10-17
- S11 (Phase 3b): [ADR-0016](../adr/0016-booking-rules-and-availability.md) (accepted by the user): versioned booking rules (slot interval, minimum notice, maximum advance, daily cap, blackout windows as local dates) per business or staff member, stored in `booking_rules`; the pure availability engine; `Intl`-based time zones. Storing rules in S11, the defaults and local-date blackouts were approved by the user at the S11 Session Brief. Working hours, buffers and staff–service eligibility stay in the base data (no duplicate rule types). No change to phases, scope or exit criteria.
- S10 (Phase 3a): [ADR-0015](../adr/0015-appointments-base-data.md) (accepted by the user): services (price "from", optional "to", in cents), staff members optionally linked to one membership, weekly hours in local time, time off in UTC; a new L2 package `@pepper/appointments`; staff manage only their own time off; composite `(tenant_id, id)` foreign keys for references between tenant tables.
- Data model: a staff member links to a membership (`staff_members.membership_id`) instead of `memberships.staff_member_id`, approved by the user at the S10 Session Brief. No scope change.
- Session plan: Phase 3 split into **S10** (base data), **S11** (rules + availability), **S12** (bookings + waitlist), **S13** (templates + exit), approved by the user. No change to phases, scope or exit criteria.

## 0.6 — 2026-10-17
- S9 (Phase 2c, part 2): [ADR-0014](../adr/0014-invites.md) (accepted by the user): single-use, 7-day invite links bound to the invitee's email, hashed tokens, at most 20 open invites per business. **Phase 2 complete** (exit criteria met; S9 merged at the user's request).
- S8 (Phase 2c): [ADR-0013](../adr/0013-roles-audit-log-and-metering.md) (accepted by the user): permission matrix in core, MFA for managers as well as owners, append-only audit log, usage meters, at most 5 businesses per owner, domain services in core. Matrix, manager MFA and the limit approved by the user at the S8 Session Brief.
- Session plan: Phase 2c split into **S8** (roles, audit, metering, team API) and **S9** (invites, Team screen, `/security-review`, Phase 2 exit), approved by the user. No change to phases, scope or exit criteria.

## 0.5 — 2026-10-16
- D10 resolved by the user: **SeaweedFS** as the dev/CI S3-compatible server → [ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md). Added to Compose in Phase 4.
- S7: [ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md) (accepted by the user): auth tables, user-keyed "my businesses" policy, session tenant context, web forwarding. Implements ADR-0007 within the approved plan; no scope change.

## 0.4 — 2026-10-16
- Mockups of all key screens approved (S1 + S2). Design tokens recorded in `product/ux-principles.md`. Phase 0 complete.
- [PCR-001](changes/PCR-001.md): the booking page uses the business's own brand color, picked in onboarding (W1, W8).

## 0.3 — 2026-10-16
- User approved all planning docs (no changes).
- ADR-0001…0006 accepted; ADR-0007 (Better Auth) and ADR-0008 (Drizzle) added and accepted, resolving D2/D3.
- Working name **Pepper**.
- Session protocol: one feature-sized goal per session, mandatory Session Brief at start, planned-sessions list in STATUS.md.

## 0.2 — 2026-10-16
- Initial planning set: product, architecture, engineering, plan docs, competitor audit, CLAUDE.md.
- Scope: all appointment-based US industries (Beauty, Wellness & fitness templates), owner/staff AI, public booking page, email-only messaging, no payments, voice in V2.
- Stack: Next.js, NestJS, OpenAI, PostgreSQL + pgvector, Redis + BullMQ, Google Calendar, S3-compatible storage, Sentry + OTel; lean deployment (Docker → VPS → AWS).
- ADRs 0001–0006 proposed.

## 0.1 — 2026-10-16
- First draft (salon-only, superseded).
