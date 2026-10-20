# ADR-0022: Public booking page: slug lookup, emailed codes, link tokens and a dev email sender

- **Status:** Proposed by Claude (S17, 2026-10-20), after the user said "give me the Session Brief, then continue"; for the user to accept or change in review. · **Date:** 2026-10-20 · Builds on ADR-0010 (RLS), ADR-0014 (hashed tokens), ADR-0017 (bookings), ADR-0019 (design system), PCR-001 (brand color)

## Context
W8 lets a client book without an account. AC-W8-2 says a booking is made only after email verification, and the confirmation carries reschedule/cancel links scoped to that booking. Four things were missing:
- A way to find a business **before any tenant is known**, from the slug in the page's URL, without weakening RLS.
- Somewhere to keep a **request that waits for its code**, and the code itself, safely.
- A **secret per booking** for the client's link.
- An **email sender**. Phase 5 brings the transactional outbox, but the page needs to send codes now (the S17 brief's open question).

## Decision
1. **Slug lookup.**
   - Migration 0021 adds `current_public_slug()`, which reads the transaction-local `app.public_slug`.
   - The `tenants` table gets a read-only `public_lookup` policy: `current_tenant_id() IS NULL AND slug = current_public_slug()`.
   - `withPublicTenant(db, slug, work)` finds the business that way, clears the setting, then binds the transaction to that tenant **without a user**, as `withInviteTenant` does for invites.
   - That transaction has the full tenant scope ("work without a user", ADR-0017). Every public service function therefore returns only what a visitor may see: name, color, time zone, active services that someone offers, active staff (display name, color, services), free times, and the visitor's own booking.
   - The business comes from the URL, never from a body, and no tenant id is ever shown on the page.
2. **Booking requests** (`booking_verifications`, migration 0022, hardened in 0023).
   - Each row holds the service, the staff member (or `NULL` for anyone), the time, name, email and phone.
   - It also holds `code_hash`: an **HMAC-SHA256 of email and code under a key derived from `AUTH_SECRET`** (HKDF, purpose `pepper/booking-page-codes`). A million six-digit codes are quick to try, so a leaked table without the key reveals none.
   - Each code allows **5 attempts** and expires after **10 minutes**. A wrong code commits its attempt before the 422 answer.
   - The restrictive `member_scope` policy (`current_user_id() IS NULL`) keeps every member, owners included, away from these rows.
   - At most **5 requests per email address per business per hour**. This is counted by `expires_at`, so the app clock decides.
   - Nothing is booked, and the time is **not held**, before the code. The time is checked when the code is asked for and again under the staff lock at confirm.
   - If the time went meanwhile, the answer is 409 with the nearest times. The **same code may then confirm one of them** (`startsAt` on confirm): the code proves the email address, not the time. This is the approved mockup's "your details are saved, pick another time".
   - With anyone, confirm locks the free staff members in id order and books the first who still fits. The exclusion constraint still guards every case (AC-W8-1).
3. **Client and booking.**
   - On confirm, the business's client with the **verified** email is reused, keeping the name and phone the business already has; otherwise a client is added with source `booking_page`.
   - The booking has source `booking_page` and `created_by_user_id NULL`. Its audit entries (`client.created`, `booking.created`, and `booking.updated` for moves and cancellations) have actor **`system`**, with the source in the values.
4. **Link token.**
   - `bookings.manage_token_hash` holds the SHA-256 of 32 random bytes (unique), as for invites. A 256-bit secret needs no key or slow hash.
   - The link is `/book/<slug>/manage#<token>`. The token stays in the fragment and travels only in POST bodies (`booking/lookup`, `reschedule`, `cancel`), never in a logged URL.
   - A link only works under its own business's slug.
   - The client may move the booking (same service, duration, buffers and staff member, through the engine) or cancel it, while it is `confirmed` and has not started.
   - Team-made bookings get no token until Phase 5's confirmation emails.
5. **Email (the brief's question): a dev sender now, the outbox later.**
   - The api calls a `Mailer` port directly, with an SMTP adapter on **nodemailer 10.0.15** (pinned; the newest release over two weeks old, no dependencies).
   - `SMTP_URL` and `MAIL_FROM` are set in the environment. Compose and `.env.example` point at Mailpit.
   - The **code email must be sent**: without a mailer or on a send failure, the answer is 503 `email_unavailable`. Confirmation, move and cancel emails are best effort, because the page shows the same details and the link.
   - No address or content is logged.
   - This is a temporary exception to "side effects go through the outbox". Phase 5 moves sending behind the outbox, with retries, without changing the messages.
6. **Abuse limits.**
   - Fixed windows in **Redis**, shared by all api instances, **fail closed** (503 `temporarily_unavailable`):
     - page reads: 120 per minute per address;
     - booking requests: 10 per 10 minutes per address, and **100 per hour per business**;
     - code checks: 30 per 10 minutes per address;
     - link uses: 30 per 10 minutes per address.
   - The address is the last `X-Forwarded-For` entry. The web app's server sets it when the browser sent none, and its server-side page load passes the visitor's address on.
   - A client who sends its own header can choose the address until the Phase 11 edge proxy overwrites it. That is why the email-sending limit also counts per business.
   - Writes still need the app's `Origin` (SameOriginGuard).
7. **Brand color (PCR-001).**
   - The `tenants.brand_color` column is `#rrggbb` or `NULL`. It is set with `PUT /v1/tenant/booking-page` (`settings.manage`, audited as `tenant.updated`) from a "Your booking page" card on Services.
   - `@pepper/ui` `brandTokens` derives `biz`, `biz-strong`, `biz-soft` and `biz-on` for light and dark from any color. It darkens or lightens them **until every text pair passes AA** (property test over 2,000 random colors).
   - Without a color, a slate default is used, not Pepper's green.
   - `.bookpage` maps the tokens onto `--brand*` by the system theme, so the page uses the normal components.
8. **Screens:** `/book/<slug>` and `/book/<slug>/manage`, following the S1 mockup:
   - Steps: service → staff member or "Anyone available" → a two-week day strip with free times (and who takes each with anyone) → details → code → booked.
   - The client's choices show as "Change" chips.
   - Not built yet: address, notes, "add to calendar", cancellation policy.

## Consequences
- AC-W8-2 holds end to end (integration and Playwright). AC-W8-1 holds at the service level for two confirmations of the last slot; the Playwright race is S18.
- Two RLS-relevant additions (`public_lookup`, `booking_verifications`) are in the isolation suite.
- Expired requests are not yet cleaned up; a Phase 5 job deletes them.
- Rate limits per address are spoofable until the edge proxy (Phase 11). Bot protection (Turnstile) is also Phase 11.
- Emails are sent while the client waits, with no retry, until the outbox (Phase 5).
- Changing `AUTH_SECRET` invalidates open codes (at most 10 minutes' worth).

## Alternatives considered
- **Build the outbox now:** that is Phase 5's scope and exit criteria; it would have doubled the session.
- **Hold the time during verification:** more state and expiry work for a rare race, and holds that bots could abuse.
- **A slug lookup with `SECURITY DEFINER`:** it would bypass RLS. A read-only policy keyed by a transaction setting follows the existing invite pattern.
- **A plain SHA-256 of the code:** it can be brute-forced offline. HMAC under a server key cannot.
