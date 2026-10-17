# Plan Changelog

Plan versions use `MAJOR.MINOR`: MINOR for approved PCRs that keep compatibility; MAJOR for scope or architecture changes.

## 0.8 — 2026-10-17
- S12 (Phase 3c): [ADR-0017](../adr/0017-bookings-clients-and-waitlist.md) (proposed): bookings with a `booking_occupancy` exclusion constraint (buffers included), staff-scoped RLS (AC-W9-1), statuses `confirmed`/`completed`/`no_show`/`cancelled`, owner/manager override, alternatives for refused times, idempotency keys; a minimal `clients` table in core; the waitlist model and API. Decided by the user at the S12 Session Brief: clients table now, occupancy table, no "pending", the override, the waitlist window format and its API. Data model: "Customer" is named "client" (as the permissions and UI already were), and booking sources `owner`/`staff` became `team`. No change to phases, scope or exit criteria.

## 0.7 — 2026-10-17
- S11 (Phase 3b): [ADR-0016](../adr/0016-booking-rules-and-availability.md) (accepted by the user): versioned booking rules (slot interval, minimum notice, maximum advance, daily cap, blackout windows as local dates) per business or staff member, stored in `booking_rules`; the pure availability engine; `Intl`-based time zones. Storing rules in S11, the defaults and local-date blackouts were approved by the user at the S11 Session Brief. Working hours, buffers and staff–service eligibility stay in the base data (no duplicate rule types). No change to phases, scope or exit criteria.
- S10 (Phase 3a): [ADR-0015](../adr/0015-appointments-base-data.md) (accepted by the user): services (price "from", optional "to", in cents), staff members optionally linked to one membership, weekly hours in local time, time off in UTC; a new L2 package `@floty/appointments`; staff manage only their own time off; composite `(tenant_id, id)` foreign keys for references between tenant tables.
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
- Working name **Floty**.
- Session protocol: one feature-sized goal per session, mandatory Session Brief at start, planned-sessions list in STATUS.md.

## 0.2 — 2026-10-16
- Initial planning set: product, architecture, engineering, plan docs, competitor audit, CLAUDE.md.
- Scope: all appointment-based US industries (Beauty, Wellness & fitness templates), owner/staff AI, public booking page, email-only messaging, no payments, voice in V2.
- Stack: Next.js, NestJS, OpenAI, PostgreSQL + pgvector, Redis + BullMQ, Google Calendar, S3-compatible storage, Sentry + OTel; lean deployment (Docker → VPS → AWS).
- ADRs 0001–0006 proposed.

## 0.1 — 2026-10-16
- First draft (salon-only, superseded).
