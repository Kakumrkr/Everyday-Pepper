# ADR-0017: Bookings, clients and the waitlist

- **Status:** Accepted (user, 2026-10-17). Proposed by Claude the same day. The user made five decisions at the S12 Session Brief: a minimal clients table now, a separate occupancy table for busy times, no "pending" status, an owner/manager override, and the waitlist window format with API endpoints. The other choices below are defaults for the user to accept or change. · **Date:** 2026-10-17 · Builds on ADR-0016 (rules, availability engine), ADR-0015 (base data), ADR-0013 (roles, audit log), ADR-0012 (sessions, tenant context) and ADR-0010 (RLS)

## Context
Phase 3c makes bookings real. The roadmap asks for a booking table whose exclusion constraint makes double booking impossible, and for statuses and sources. It also asks for AC-W9-1 enforced at the RLS level: a staff user sees and edits only their own bookings. Two more needs follow:
- Bookings need someone to be for, but no clients table existed yet.
- Everyone on the team must still see when colleagues are busy, both for the calendar and for availability.

ADR-0016 also requires the database to guard the same *occupied* time the engine checks: the appointment plus its buffers.

## Decision
1. **Clients (user, S12): a minimal `clients` table now, in core (L1).**
   - Columns: name, optional email (lowercased, unique per business), optional E.164 phone, and a source (`team`/`ai`/`booking_page`/`import`).
   - Consent flags, tags, notes and import references come with the features that use them.
   - The table is called `clients`, not `customers`, to match the permissions (`clients.*`) and the UI. The data model is updated.
   - `GET/POST /v1/clients` and `GET /v1/clients/:id`. Adding a client needs `clients.manage`, which is owners and managers (S8 matrix).
2. **Bookings.**
   - Columns: client, service and staff member (composite tenant keys); `starts_at`/`ends_at`.
   - A copy of the service's buffers and price at booking time, so editing a service never moves or reprices existing bookings.
   - `status`, `source`, `overridden`, an optional `idempotency_key`, and `created_by_user_id`.
   - Database checks: duration 5–720 minutes, buffers 0–240, known statuses and sources, and the key format.
3. **No double booking: `booking_occupancy` + exclusion constraint (user, S12).**
   - What it stores: an `AFTER INSERT/UPDATE` trigger on `bookings` keeps one row per active (not cancelled) booking. Each row has the staff member, the appointment times and `occupied tstzrange`, which is the appointment plus its buffers, half-open.
   - The constraint: `EXCLUDE USING gist (staff_member_id WITH =, occupied WITH &&)` makes overlapping occupied time impossible, including under races. The second of two racing transactions waits and then fails with 23P01, which is answered as `slot_unavailable`.
   - Why a separate table: RLS can hide rows but not columns. The occupancy table carries no client or booking details, so every member may read it (busy times, availability). `bookings` itself gets the staff-only policy.
   - The trigger runs as the caller (SECURITY INVOKER), so the occupancy table's own write policies apply to it too.
4. **Statuses (user, S12):**
   - `confirmed`: every booking starts here. There is no "pending": AI bookings wait as proposals (AC-W2-2), and the booking page verifies the email before creating anything (AC-W8-2).
   - `completed` and `no_show`: these record what happened, so they are allowed only once the appointment has started.
   - `cancelled`: final, and the only status that frees the time.
   - Moves are allowed only while the booking is `confirmed`.
5. **Sources:** `team` (made in the app by a member), `ai`, and `booking_page`. The data model's `owner`/`staff` became `team`, because who made a booking is already in `created_by_user_id` and the audit log.
6. **Member scope: AC-W9-1 at the RLS level.**
   - Binding the user: tenant-scoped services now bind the member's user as well as the tenant (`withMember`: `app.user_id`, transaction-local).
   - Two SQL functions:
     - `current_member_sees_all()`: true for owners, managers, and work without a user (jobs, the booking page).
     - `current_member_staff_ids()`: the staff member linked to the user's membership.
   - Restrictive `member_scope*` policies narrow `tenant_isolation`; they never widen it:
     - `bookings` and `waitlist_entries`: rows of one's own staff member. An entry for "anyone" is not a staff member's.
     - `clients`: read only those with one of one's bookings or waitlist entries; no writes or deletes for staff.
     - `booking_occupancy`: read by all; written only for one's own staff member.
   - Effect: a removed member, or staff without a linked staff member, sees none of these rows.
   - The policies call the functions through sub-selects, so they are evaluated once per statement.
   - The domain services check the same thing (ADR-0013 (b)): booking for or moving to another staff member is a 403, and reading or changing another staff member's booking or waitlist entry is a 404, as RLS would answer.
   - Mutation tests show each layer holds alone, with one exception: clients are scoped by RLS only, because their scope ("has a booking or waitlist entry with you") is defined by that policy.
7. **Every booking passes the availability engine (ADR-0016) at write time.**
   - The staff member's row is locked (`FOR UPDATE`) while the engine checks the time against stored hours, time off, rules and occupancy, and the booking is written. This keeps the daily cap correct under concurrency; the exclusion constraint alone cannot count bookings per day.
   - Moves lock staff members in id order, so two crossing moves cannot deadlock.
   - Override (user, S12): owners and managers may pass `override: true` to book outside hours, time off and rules. The staff member must still be active and offer the service, and an overlap is never allowed. The booking is marked `overridden`. Staff cannot override (403).
8. **Refused times offer alternatives (AC-W2-1).** `409 slot_unavailable` carries the 3 slots nearest the asked time, earlier first on a tie. They are for the same service and staff member, searched a week either side and never before `now`, and read in a fresh transaction after the refused one rolled back.
9. **Idempotency.**
   - An optional `idempotencyKey` (8–100 of `[A-Za-z0-9_-]`) is unique per business.
   - A retry with the same request returns the first booking. The same key with a different request is a 409 `idempotency_key_reused`.
   - The key is looked up after the staff lock. A concurrent first attempt with the same key has therefore committed by then, and the retry gets its booking rather than "time taken".
10. **Waitlist (user, S12: model, services and API).**
    - `waitlist_entries` columns: client, service, optional staff member ("anyone" when NULL), and 1–10 `windows`. A window is a local date plus `HH:MM` times in the business's time zone, like hours and blackouts.
    - `expires_at`: the end of the last window, computed with `zoned-time`. An entry whose windows have all passed is refused (`waitlist_expired`).
    - Stored statuses: `waiting`, `offered`, `booked` and `cancelled`. `expired` is derived when an entry is read, so no job is needed to expire entries. `booked` requires `booking_id` (check).
    - Endpoints: `GET/POST /v1/waitlist` and `PATCH /v1/waitlist/:id` (cancel only).
    - Out of scope here: matching, ranking, offers and their expiry (Phase 8, AC-W5-1, through the Phase 5 outbox).
11. **Reading:**
    - `GET /v1/bookings` and `GET /v1/bookings/:id`: staff get only their own; another's is a 404.
    - `GET /v1/calendar/busy`: the occupancy of everyone, without details (`calendar.read`).
    - `GET /v1/availability`: the engine over stored data, the same for every role.
    - Ranges are at most 62 days.
12. **Audit:**
    - `client.created` (source only); `booking.created` / `booking.updated` (ids, times, status, source, overridden); `waitlist_entry.created` / `.updated` (ids, expiry, stored status).
    - Never a client's name, email or phone, nor the waitlist windows.
    - An unchanged booking update is not audited.
13. **Tests:**
    - The isolation suite covers the four tables and their exact policies.
    - `bookings.int` (db) proves the constraint, including 8 concurrent attempts where exactly one wins; the trigger; references; checks; and the member scope per role.
    - Two fast-check properties against real Postgres prove that concurrent bookings and overrides never double-book, and that concurrent bookings never exceed the daily cap.
    - Mutation checks:
      - Making the bookings `member_scope` policy `true` fails 6 tests.
      - Replacing the staff lock with a plain read fails the daily-cap property.

## Consequences
- **Staff can only book clients they already have** (a booking or a waitlist entry with them). A stylist cannot yet book a returning client of a colleague, or a new walk-in. This follows the approved matrix (`clients.read` own, `clients.manage` owners and managers) and is **an open question for the user before the Phase 4 screens**. Options:
  - let staff search all clients by exact email or phone;
  - let staff add clients;
  - keep it as it is.

  **Decided (user, 2026-10-17, on Claude's recommendation): staff may find any client by exact email or phone.** A match lets them book that client; it shows only that one client and never lists the rest. Staff still cannot add clients, so `clients.manage` stays with owners and managers and the S8 matrix is unchanged. A walk-in is added by an owner or manager. Built with the Phase 4 booking screens; until then the api behaves as described above.
- `current_user_id()` is now used inside tenant transactions too, not only by `member_read`. Code that runs without a user (jobs, the booking page) gets the business's full tenant scope, as before. Only member requests go through `withMember`.
- Bookings and waitlist entries keep services, staff members and clients by `NO ACTION` keys: none of these can be deleted yet. Deleting a client (GDPR) needs a decision on their bookings, anonymise or delete, in the phase that adds it.
- The trigger rewrites a booking's occupancy row on every relevant update. That is cheap at salon scale.
- The Phase 4 booking page creates bookings without a user, through the same domain code, with source `booking_page`.
- Templates (S13) pass their rule defaults to `resolveRules`; `staffAvailabilityOf` already accepts them.
- Google Calendar busy blocks (Phase 10) fill the engine's `busy` input. The engine and the exclusion constraint do not need to change.
