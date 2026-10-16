# Data Model (V1, logical)

> Provides: entities and invariants · Depends on: modules-and-templates, memory, AI trust layer · Consumed by: packages/db, all services

All tenant-owned tables: `id (uuid v7)`, `tenant_id`, `created_at`, `updated_at`, RLS policy `tenant_id = current_setting('app.tenant_id')`. Timestamps UTC (`timestamptz`).

## L1 Core
| Entity | Key fields / notes |
|---|---|
| Tenant | name, slug (booking page), template_id, time_zone, locale, plan, settings (JSON, versioned) |
| User | auth identity (global), email, MFA |
| Membership | user_id, tenant_id, role (`owner`/`manager`/`staff`), staff_member_id? |
| Customer | names, email, phone?, consent flags, tags, source, import_ref |
| Conversation / Message | channel (`app`; later `sms`, `voice`), role, content, cards |
| ActionProposal / ActionExecution | see AI trust layer; idempotency_key unique per tenant |
| MemoryFact / MemoryEpisode | episode has `embedding vector` (pgvector, HNSW index) |
| Task | title, due_at, assignee, status, source |
| FeedItem | kind, status (`done`/`needs_ok`/`suggestion`/`dismissed`), payload, action_proposal_id? |
| OutboxMessage | type, payload, status, attempts, dedupe_key unique |
| Notification / MessageDelivery | channel, recipient, template, status, provider_id |
| AuditLog | actor, action, entity, before/after (redacted), at — append-only |
| UsageMeter | tenant, metric (llm_tokens, emails, …), period, amount |
| Integration / OAuthToken | provider, encrypted tokens (envelope encryption), status |
| File | storage key, mime, size, purpose |

## L2 Appointments
| Entity | Key fields / notes |
|---|---|
| Service | name, duration, buffers, price_display, category, active |
| StaffMember | display name, services (M:N), color |
| WorkingHours / TimeOff | per staff, recurrence, tz-aware |
| Rule | type, params (JSON, Zod), source (`template`/`tenant`/`learned`), version |
| Booking | customer, staff, service, `during tstzrange`, status, source (`owner`/`staff`/`ai`/`booking_page`), external_event_ref; **EXCLUDE USING gist (staff_id WITH =, during WITH &&) WHERE status active** |
| WaitlistEntry | customer, service, staff?, windows, status, expires_at |
| ExternalBusyBlock | staff, during, source calendar, external id |
| BookingVerification | email code hash, expires, attempts (public booking) |

## Invariants
No overlapping active bookings per staff (DB constraint) · every write has an audit entry · every side effect goes through `OutboxMessage` · deleting a customer cascades memory facts/episodes about them.
