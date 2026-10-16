# Jobs, Messaging & Integrations

> Provides: background processing, outbox, messaging channels, Google Calendar sync, onboarding import · Depends on: Redis/BullMQ, db, contracts · Consumed by: reminders, feed, waitlist, onboarding

## Background jobs (Redis + BullMQ in `apps/worker`)
| Queue | Purpose | Trigger |
|---|---|---|
| `outbox-relay` | Deliver `OutboxMessage` rows to handlers | Polling + notify after commit |
| `reminders` | Booking confirmations/reminders | Scheduled per booking (delayed jobs), reconciled nightly |
| `daily-briefing` | Build operator feed per tenant at local morning | Repeatable job per tenant time zone |
| `insights` | Compute open slots, overdue regulars, no-show patterns | Hourly + on events |
| `waitlist` | Match and offer on cancellation | `booking.cancelled` event |
| `calendar-sync` | Google Calendar push/incremental sync | Webhook + every 15 min |
| `imports` | CSV import, onboarding extraction | User action |

**Guarantees:** the DB is the source of truth; jobs carry IDs, not data. Transactional outbox (write + outbox row in one transaction) avoids lost/phantom side effects. Handlers are idempotent (dedupe keys). Exponential backoff, max attempts, dead-letter queue with alert. Redis loss is recoverable: reconciliation jobs rebuild schedules from Postgres.

## Messaging (channel-agnostic)
`MessagingChannel` interface: `send(message) → deliveryId`, `status webhook`. V1: **Email** via Amazon SES (cheapest) or Resend (simplest) — decide in ADR. Templates per message type, rendered with tenant branding and template terminology. Unsubscribe/opt-out honoured; CAN-SPAM footer. V1.1 adds SMS (Twilio, A2P 10DLC, TCPA consent) without changing callers.

## Google Calendar sync
Per staff OAuth connection. Inbound: external events → `ExternalBusyBlock` (block availability, details not stored beyond title-optional). Outbound: our bookings → events in the staff's calendar. Source of truth for bookings is our system. Push notifications + sync tokens; full resync on token invalidation; conflicts resolved by "external busy always blocks, our bookings win for our events". Requires Google OAuth app verification before public launch.

## Onboarding extraction
Fetch website / Google Business profile (public data) or OCR a price-list photo → LLM structured output into template-shaped draft → validation → review card. Fetched content treated as untrusted. Competitor CSV import via column mapping presets + AI-assisted mapping for unknown formats; dry-run report before commit.

## Files
S3-compatible storage (dev server: open decision D10 — MinIO no longer ships images; R2/S3 in pilot): uploads, imports, exports. Pre-signed URLs, private by default, tenant-prefixed keys.
