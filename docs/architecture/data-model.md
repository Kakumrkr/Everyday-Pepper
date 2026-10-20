# Data Model (V1, logical)

> Provides: entities and invariants · Depends on: modules-and-templates, memory, AI trust layer · Consumed by: packages/db, all services

All tenant-owned tables: `id (uuid v7)`, `tenant_id` (defaults to the transaction's tenant), `created_at`, `updated_at` (trigger), forced RLS with one policy `tenant_isolation`: `tenant_id = current_tenant_id()`, i.e. `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, for reads and writes. Timestamps UTC (`timestamptz`). Roles, migrations and `withTenant`: [ADR-0010](../adr/0010-database-roles-and-migrations.md). Built so far (S6–S9): `tenants` (name, slug, time_zone, locale), `memberships` (user_id → users, role), `audit_log` and `usage_meters` (S8, [ADR-0013](../adr/0013-roles-audit-log-and-metering.md)), `invites` (S9, [ADR-0014](../adr/0014-invites.md)), and the global auth tables below.

**Global (not tenant-owned) tables** have no `tenant_id` and no RLS, and are listed with a reason in the isolation suite. They are Better Auth's tables ([ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md)):
- `users`: name, email (lowercased, unique), `two_factor_enabled`.
- `sessions`: token, expiry, IP and user agent for security, `active_tenant_id` (set only by the api after a membership check; `SET NULL` when the business is deleted).
- `accounts`: password hash; OAuth tokens later.
- `verifications`.
- `two_factors`: encrypted TOTP secret and backup codes, lockout counters.

Deleting a user cascades to their sessions, accounts, second factor and memberships. A signed-in user reads their own memberships and businesses across tenants only through `withUser` (read-only `member_read` policies, applied only when no tenant is set).

## L1 Core
| Entity | Key fields / notes |
|---|---|
| Tenant | name, slug (booking page), brand_color (S17, PCR-001: `#rrggbb` or `NULL`), template_id (S13: nullable, one of the V1 template ids from the contracts; `NULL` = platform defaults only, ADR-0018), time_zone, locale, plan, settings (JSON, versioned) |
| User | auth identity (global, Better Auth `users`), email, MFA (`two_factors`) |
| Membership | user_id, tenant_id, role (`owner`/`manager`/`staff`); a staff member may link to it (ADR-0015) |
| Client (`clients`, S12) | name, email? (lowercased, unique per tenant), phone? (E.164), source (`team`/`ai`/`booking_page`/`import`); consent flags, tags and import_ref come with the features that use them. Called "client" everywhere (permissions `clients.*`, UI); staff read only clients they have a booking or waitlist entry with, and never write (ADR-0017) |
| Conversation / Message | channel (`app`; later `sms`, `voice`), role, content, cards |
| ActionProposal / ActionExecution | see AI trust layer; idempotency_key unique per tenant |
| MemoryFact / MemoryEpisode | episode has `embedding vector` (pgvector, HNSW index) |
| Task | title, due_at, assignee, status, source |
| FeedItem | kind, status (`done`/`needs_ok`/`suggestion`/`dismissed`), payload, action_proposal_id? |
| OutboxMessage | type, payload, status, attempts, dedupe_key unique |
| Notification / MessageDelivery | channel, recipient, template, status, provider_id |
| AuditLog (`audit_log`, S8) | actor_kind (`user`/`system`), actor_user_id (→ users, nulled on user deletion), action, entity_type, entity_id, before/after (jsonb, per-action allowlist in contracts: no personal data), request_id, created_at — append-only (the services' role has INSERT/SELECT only) |
| Invite (`invites`, S9) | email (lowercased), role, token_hash (SHA-256 hex of the link's token, unique), invited_by_user_id / accepted_by_user_id (→ users, nulled on deletion), expires_at (7 days), accepted_at, revoked_at (never both); one unresolved invite per tenant + email (partial unique index); extra read-only policy `invite_lookup` for the token holder when no tenant is set |
| UsageMeter (`usage_meters`, S8) | tenant, metric (`llm_tokens`, `emails_sent`), period (`YYYY-MM`, UTC month), amount (bigint ≥ 0); unique per tenant + metric + period, atomic upsert |
| Integration / OAuthToken | provider, encrypted tokens (envelope encryption), status |
| File | storage key, mime, size, purpose |

## L2 Appointments
| Entity | Key fields / notes |
|---|---|
| Service (`services`, S10) | name (unique per tenant, case-insensitive), category?, duration 5–720 min, buffers before/after 0–240 min, price_from_cents? / price_to_cents? (integer cents; "from", optionally up to "to"), active |
| StaffMember (`staff_members`, S10) | display_name, color `#rrggbb`, active, membership_id? (→ memberships, one staff member per membership, SET NULL when the member is removed); services M:N via `staff_services` |
| WorkingHours (`working_hours`, S10) | staff, ISO weekday, start/end minute after **local** midnight (tenant time zone); no overlap per staff and day (exclusion constraint) |
| TimeOff (`time_off`, S10) | staff, starts_at/ends_at (UTC, ≤ 366 days), created_by_user_id; no free-text reason |
| BookingRule (`booking_rules`, S11) | type (`slot_interval`/`minimum_notice`/`maximum_advance`/`max_bookings_per_day`/`blackout_window`), params (JSONB, validated by the contracts' `RuleSchema`), schema version, optional staff member (`NULL`: the whole business); one per type and scope except blackout windows (partial unique index). Template defaults are not stored: the api passes `@pepper/templates`' defaults for the business's `template_id` at read time (S13, ADR-0018); learned rules add a source in Phase 7 (ADR-0016) |
| Booking (`bookings`, S12) | client, service, staff member (composite tenant keys), starts_at/ends_at (UTC), copy of the service's buffers and price, status (`confirmed`/`completed`/`no_show`/`cancelled`), source (`team`/`ai`/`booking_page`), overridden, idempotency_key? (unique per tenant), created_by_user_id; external_event_ref comes with calendar sync (Phase 10). Staff reach only their own staff member's rows (`member_scope`, AC-W9-1) (ADR-0017) |
| BookingOccupancy (`booking_occupancy`, S12) | one row per active booking, kept by a trigger on `bookings`: staff member, appointment times, `occupied tstzrange` (appointment + buffers); **`EXCLUDE USING gist (staff_member_id WITH =, occupied WITH &&)`** — no double booking; readable by every member (busy times without details) (ADR-0017) |
| WaitlistEntry (`waitlist_entries`, S12) | client, service, staff member? (`NULL`: anyone), windows (1–10 local date + `HH:MM` spans, jsonb), status (`waiting`/`offered`/`booked`/`cancelled`; `expired` derived on read), expires_at (end of the last window), booking_id (set iff `booked`) (ADR-0017) |
| ExternalBusyBlock | staff, during, source calendar, external id |
| BookingVerification | `booking_verifications` (S17, ADR-0022): service, staff member or `NULL` (anyone), time, name, email, phone, HMAC code hash, attempts, expires, booking once confirmed (public booking). Bookings made from it keep `manage_token_hash` for the client's link |

## Invariants
References between tenant tables are composite foreign keys on `(tenant_id, id)` (ADR-0015) · No overlapping occupied time (buffers included) of active bookings per staff member (DB constraint on `booking_occupancy`) · every write has an audit entry · every side effect goes through `OutboxMessage` · deleting a customer cascades memory facts/episodes about them.
