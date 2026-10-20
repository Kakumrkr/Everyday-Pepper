# ADR-0024: Transactional outbox, email delivery in the worker, and the email provider

- **Status:** Proposed (Claude, 2026-10-20, S19). At the S19 Session Brief the user chose Claude's recommendations on all five questions: the code email stays direct; queued content is encrypted and cleared after sending; the worker finds work through a small index table; Resend is the email provider for the pilot; Phase 5 is split as below. · **Date:** 2026-10-20 · Builds on ADR-0003 (BullMQ + outbox), ADR-0010 (roles and RLS), ADR-0013 (metering), ADR-0022 (booking page emails)

## Context
ADR-0003 decided that every side effect is first written as an outbox row in the same transaction as the business change, and that a relay and idempotent BullMQ handlers deliver it. Until now (ADR-0022) the api sent the booking page's emails directly over SMTP while the client waited. A failed send was lost, and nothing retried it. Phase 5's exit criterion is AC-W4-2: *exactly one email per recipient is sent even if the job retries*.

Five questions were open:
- Which emails go through the outbox.
- How queued content is protected. The confirmation carries the client's private reschedule/cancel link, whose secret the database otherwise only stores as a hash.
- How a worker with no tenant finds work across businesses without weakening RLS.
- Which email provider the pilot uses (D4).
- How Phase 5 is split into sessions.

## Decision
1. **What goes through the outbox.**
   - The emails about a booking (confirmed, moved, cancelled) are queued inside the booking change's transaction. The appointments functions take a `notify` option, called in that transaction. The api renders the email there and calls `queueEmail` (core).
   - **The 6-digit code email stays direct.** The client is waiting for it. A failure is still a 503 ("try again"), and a lost code is simply asked for again. Queueing it would add the relay's delay to a screen that waits.
2. **Tables** (migrations 0024–0026).
   - `outbox_messages` is tenant-owned, with forced RLS and the `tenant_isolation` policy. It holds:
     - the type (`email`)
     - a **dedupe key**, unique per business, made only of `[A-Za-z0-9.:_-]` so it never carries personal data, e.g. `booking.confirmed:<booking id>:<updated_at ms>`
     - the sealed content
     - the status (`pending`/`sent`/`dead`), attempts, `available_at`, `lease_until`, the last error's name (never its message), and `sent_at`
   - Constraints keep content only while `pending` and `sent_at` only when `sent`.
   - `outbox_dispatch` is the relay's index: the message id, its business and its due time, **no content**. One row exists per pending message, and it is removed when the message is sent or dead. It is tenant-owned too, with forced RLS and `tenant_isolation`. Its foreign key to the message cascades.
3. **Finding work across businesses.**
   - A read-only `outbox_scan` policy on `outbox_dispatch` applies only when no tenant is set and the transaction-local setting `app.outbox_scan` is on (`current_outbox_scan()`, migration 0024).
   - Only `listDueOutboxMessages` sets it, in a read-only transaction. This is the same pattern as the booking page's slug lookup and the invite lookup.
   - The relay therefore sees ids and due times of every business and nothing else. The isolation suite proves it: no other table is visible, no write is possible, and a tenant transaction is not widened.
   - Everything else about a message is read and written under its own business's tenant.
4. **Sealing content.**
   - The content (to, subject, text) is JSON encrypted with **AES-256-GCM**. The key is derived (HKDF-SHA256, purpose `pepper/outbox-messages`) from a new required secret, **`OUTBOX_SECRET`** (at least 32 characters, the same in api and worker).
   - The message id is the associated data, so content copied into another row does not open.
   - The layout is versioned: version byte, IV, tag, ciphertext.
   - The content is **cleared** when the message is sent or given up.
   - Content that does not open (for example, the secret changed) is given up at once.
5. **Delivery** (`deliverOutboxMessage`, core).
   - **Claim:** a conditional `UPDATE` (pending, due, lease free) counts the attempt and sets a **5-minute lease**. The claim commits before sending, so concurrent workers get one claim.
   - **Send** with `Message-ID: <message id@sender domain>`, stable across resends.
   - **Mark sent** and meter `emails_sent` (ADR-0013) in one transaction. A message that is not pending is left alone.
   - **On failure:** a 5xx answer (for example, an unknown mailbox) or unreadable content gives up at once. Anything else retries with backoff: 30 s doubling to at most 1 h, **8 attempts**, about 2 hours in all. After the last attempt the message is `dead`: an error log plus a Sentry alert with ids only (`raiseAlert`, runtime).
   - SMTP timeouts (10 s connect, 30 s socket) stay far below the lease.
6. **Worker wiring** (`apps/worker/src/outbox/`).
   - The relay polls every `OUTBOX_POLL_MS` (default 1 s) and adds one BullMQ job per due message to the `outbox` queue. The **job id is the message id**, so a message already waiting is not queued twice. Finished jobs are removed, so a retry gets a new job.
   - Retries and backoff live in Postgres, not in BullMQ (one BullMQ attempt per job). Postgres stays the source of truth, and losing Redis loses nothing: the relay re-queues from the index.
   - Polling only. The api does not notify Redis after commit (one less moving part; a second of latency is fine for these emails).
   - Without `SMTP_URL` the worker starts nothing and logs that queued emails wait.
7. **Mailer.** The `Mailer` port and `EmailMessage` live in core. `SmtpMailer`, `MailModule` and the mail and outbox environment loaders move from the api to `@pepper/runtime`, so the api (codes) and the worker (outbox) share them.
8. **Email provider (D4): Resend for the pilot.** It is the simplest to set up, and its API takes an idempotency key. Passing the message id there closes the gap in Consequences for real sends. Development and CI keep Mailpit over SMTP. Built at Phase 11 (pilot), behind the same `Mailer` port; no code changes for callers.
9. **Phase 5 split:**
   - S19: this outbox.
   - S20: confirmations for team-made bookings, reminders with timing (AC-W6-1), and expired-request cleanup.
   - S21: tasks and push notifications.

## Consequences
- **Exactly once, with a stated limit.** Duplicate jobs, many relay passes, concurrent workers, failed sends and retries all lead to one email (proven against real Postgres, Redis/BullMQ and Mailpit, including Mailpit refusing mail and then recovering). One case can still send twice over plain SMTP: the process dies **after** the mail server accepted the email and **before** the row is marked sent. After the lease it is sent again, with the same `Message-ID`. Resend's idempotency key removes this for real sends (decision 8).
- A booking change and its email commit together. A rolled-back change sends nothing; a committed one is never lost.
- One more required secret, `OUTBOX_SECRET`, for api and worker (Compose and `.env.example` have a local-only default). Rotating it gives up emails still queued (at most a few hours' worth). A key id for rotation can follow if needed.
- Emails about a booking now arrive about a second later (the relay's poll), and only when the worker runs. Playwright already runs it.
- Members' transactions may queue messages (S20 will, for team-made bookings). No endpoint reads the outbox. A screen showing delivery status would need its own read rule.
- Dead messages stay (without content) for a person to look at. A clean-up job for old `sent`/`dead` rows can come with the other Phase 5 clean-up.
- New dependency: **BullMQ 6.3.11** (pinned) in the worker. `ioredis` and `nodemailer` were already in use.
