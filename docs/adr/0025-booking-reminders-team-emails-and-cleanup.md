# ADR-0025: Booking reminders, emails for team-made bookings, and the daily clean-up

- **Status:** Accepted (user, 2026-10-20, "All good" after reviewing S20, including Claude's defaults). At the S20 Session Brief the user chose Claude's recommendation on all six questions ("Go with your recommendations"), then approved the plan ("All sounds good start it"): reminders 24 h before for every business; none for a booking made or moved less than 24 h ahead; team changes email the client with an "Email the client" checkbox, ticked by default; a reschedule/cancel link for team-made bookings too; retention of 24 h for expired booking requests and 30 days for finished outbox messages; a reminder schedule in Postgres checked every minute. · **Date:** 2026-10-20 · Builds on ADR-0003 (outbox), ADR-0017 (bookings), ADR-0022 (booking page and its link), ADR-0024 (outbox delivery)

## Context
S19 built the outbox, and only the booking page used it. Phase 5 still needed:
- confirmations for bookings the team makes in the app,
- reminders with timing: *a reminder email within 5 minutes of schedule; cancelled bookings never receive one* (AC-W6-1),
- the clean-up of expired booking requests (S18 security finding L7) and of old outbox rows (ADR-0024).

The architecture doc had sketched reminders as BullMQ delayed jobs per booking, rebuilt nightly from Postgres.

## Decision
1. **A reminder schedule in Postgres** (`booking_reminders`, migrations 0027–0029).
   - One row per confirmed booking whose reminder is still to be sent: the booking's id, its business, `due_at` and the `starts_at` it was planned for. **No content**, nothing personal.
   - The row is tenant-owned (forced RLS, `tenant_isolation`), with a composite foreign key to the booking that cascades, and a check that it is due before the start.
   - **Kept in step inside the booking's own transaction** (`keepReminderInStep`, appointments). Every write path calls it: team create, move and status change, and booking-page confirm, reschedule and cancel. A confirmed booking more than 24 h ahead gets a row due exactly 24 h before its start (UTC instants, so daylight-saving changes do not shift it). Anything else (cancelled, completed, no-show, or less than 24 h ahead) removes the row.
   - Rather than BullMQ delayed jobs: nothing has to be rebuilt after a Redis loss, no nightly reconciliation is needed, and a cancellation simply deletes the row in the same transaction.
2. **The reminder job** (`sendDueReminders`, appointments; run by the worker every `REMINDER_POLL_MS`, default 60 s, at most 4 min).
   - It lists due rows across businesses through a read-only **`job_scan`** policy (decision 4), ids only.
   - Per reminder, under the business's tenant, in one transaction:
     1. **lock the booking** (`FOR UPDATE`), then take the reminder row (`DELETE … RETURNING`). The order is the same as every booking change, so a concurrent cancellation or move either commits first and is seen, or waits;
     2. queue the reminder email in the outbox if the booking is still confirmed, still at the planned start, has not started, and its client has an email address. Otherwise the row is just gone.
   - Dedupe key `booking.reminder:<booking id>:<start ms>`. Concurrent workers queue one email.
   - The outbox (ADR-0024) sends it about a second later. A pass handles batches of 100 until none is left (at most 20 batches), so a backlog after downtime clears in one pass.
   - The reminder has **no reschedule/cancel link**: only the link's hash is stored. It tells the client to use the link in their confirmation or to contact the business.
3. **Emails for team-made bookings.**
   - `notifyClient` (default `true`) on `POST /v1/bookings` and on both forms of `PATCH /v1/bookings/:id` (additive contract change). The web app shows "Email the client …", ticked, on the new-booking, move and cancel screens.
   - The appointments services call the same `notify` as the booking page with a `BookingNotice`: confirmed, rescheduled or cancelled. Completed and no-show send nothing. The api's `BookingEmails` (one provider shared by both) renders the email and queues it in that transaction.
   - **A confirmation or a move carries a new reschedule/cancel link.** The token is minted and its hash stored on the booking in the same transaction. A move therefore **replaces** the client's link, and the old one stops working, because the old secret cannot be recovered. A move with the box unticked keeps the old link.
   - Clients without an email address get nothing, and no link is minted.
   - The email templates move from the api to `@pepper/appointments`, so the worker renders reminders with the same wording and time-zone formatting.
4. **Scans across businesses: `job_scan`.**
   - A read-only policy that applies only when no tenant is set and the transaction-local setting `app.job_scan` names the job (`current_job_scan(job)`, migration 0027). Only `withJobScan` (db) sets it.
   - `reminders` reads `booking_reminders`. `cleanup` reads `tenants` (names, slugs and time zones, which the booking page shows publicly anyway).
   - The isolation suite proves for both jobs: only that table is visible, no writes, the other job's name does not work, a tenant transaction is not widened, and it ends with the transaction.
5. **Daily clean-up** (`cleanUp`, core; run by the worker at start-up and every `CLEANUP_INTERVAL_MS`, default one day).
   - It pages through the businesses (`job_scan`), then deletes under each business's tenant, in batches of 1000:
     - booking requests 24 h after they expired (name, email, phone, code hash; closes S18 L7). The rate limit counts only the last hour's requests;
     - outbox messages `sent` or `dead` for 30 days (their content is already cleared). Pending messages are never touched.
   - Several workers may run it at once: deleting is idempotent. It logs counts only.
6. **Worker wiring** (`apps/worker/src/jobs/`). Both jobs run on a small `Periodic` helper: passes never overlap, a failing pass is logged once by error name, and shutdown waits for the pass in flight. Neither job needs `SMTP_URL`; reminder emails wait in the outbox like any other. The worker may now import `@pepper/appointments` (the dependency map already allowed modules; the lint rule caught up).

## Consequences
- AC-W6-1 holds by construction: a pass every ≤ 4 min plus the outbox's 1 s poll. It is proven with a controlled clock (timing, cancelled, moved, concurrent workers, a racing cancellation, a backlog) and end to end on the real clock through the job, the outbox, Redis and Mailpit (received in seconds).
- A booking made or moved less than 24 h ahead gets no reminder: its confirmation or move email has just gone out. If the team unticks the box, the client gets neither.
- Reminders are a platform rule (24 h, everyone). A per-business or per-template setting can come later without changing the table: the row stores its due time.
- Team-made bookings now reach the client's inbox by default. A move by the team replaces the client's link (see decision 3).
- The reminder job is pure Postgres polling. At pilot scale the cost is one index scan a minute.
- Old `sent`/`dead` outbox rows are deleted after 30 days, so the dedupe keys go too. A change cannot be retried that late, and a reminder's row is long gone by then.
- New tables and policies: `booking_reminders`, `job_scan` on it and on `tenants`. New env (worker): `REMINDER_POLL_MS`, `CLEANUP_INTERVAL_MS`, both optional. No new dependency.
