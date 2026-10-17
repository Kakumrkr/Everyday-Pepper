# ADR-0013: Roles and permissions, the audit log and usage metering

- **Status:** Proposed (2026-10-17, S8; the user approved the matrix, manager MFA, the session split and the business limit at the S8 Session Brief) · **Date:** 2026-10-17 · Builds on ADR-0005 (model proposes, domain decides), ADR-0010 (roles, RLS) and ADR-0012 (session tenant context)

## Context
Phase 2 needs owner/manager/staff roles that the UI and (from Phase 6) the AI enforce in the same way, an audit log of every change to a business, and a metering skeleton that AI budgets and billing can build on. S8 also had to decide where domain services live: until now the api's `TenancyService` called repositories directly, but AI tools (`packages/ai`, allowed to import only contracts and core) must call the same services as the UI.

## Decision
1. **One permission matrix, in `@floty/core`.** `Permission` (contracts) lists every action, including those of later phases (bookings, clients, notes, settings), so the matrix is reviewed as a whole. `PERMISSION_MATRIX` gives each role a scope per permission: `all`, `own` or none. It is typed as exhaustive, and a test pins every cell.
   - **Owner:** everything.
   - **Manager:** everything except deleting the business, billing and usage. The membership rules (point 3) also stop managers from adding, removing or changing owners.
   - **Staff:** the business, services and the team's calendar (when people are busy). For bookings, clients and notes, staff get the `own` scope: they see and edit only their own (AC-W9-1). No team, settings, audit or autonomy access.
   - `can(actor, permission, record?)`: without a record it answers "at all", which is what route guards check. With `{ ownerUserId }` it applies the `own` scope. Phase 3 maps a booking to its staff member's user.
2. **Managers need MFA, like owners** (user, S8). Both see every client and can change how the business runs. `roleRequiresMfa` lives in contracts, so the api guard and the web app's routing share one rule.
3. **Membership rules** (`decideMembershipChange`, pure). Anyone may leave a business. Changing or removing someone else takes `members.manage`. Only owners change, remove or create owners. A business always keeps at least one owner. The services apply the rules after **locking the business's memberships** (`SELECT … FROM tenants … FOR NO KEY UPDATE`) and **re-reading the actor's own role in that transaction**. Without the lock, two owners demoting each other at once both succeeded in 9 of 10 runs of the integration test.
4. **Domain services live in `@floty/core` (`src/services/`) and call `@floty/db`.** Examples: `listMembers`, `changeMemberRole`, `removeMember`, `createBusiness`, `readAuditLog`, `recordUsage`. They take an `Actor` (the tenant context from the session, plus the request id) and check permissions themselves. The api checks the route's permission first, through `@RequirePermission` on `TenantGuard` (defence in depth), and maps domain errors to `{ code, message }` responses in one place. Thin api services (`TenancyService`, `TeamService`) bind the database and request id. Core now depends on db, which the dependency map already allowed. Core's database-backed services are integration-tested and left out of its unit coverage gate, like db's repositories.
5. **The audit log is append-only and written in the change's own transaction.** `audit_log` is a tenant table: forced RLS, `tenant_isolation`. The services' role keeps only INSERT and SELECT (`REVOKE UPDATE, DELETE, TRUNCATE`), and the isolation suite checks every table's grants.
   - **Columns:** actor (`user` with id, or `system`), action, entity type and id, `before`/`after` (jsonb), the `x-request-id`, and `created_at`.
   - **No personal data, by allowlist:** each action has a strict Zod schema in contracts, and `appendAuditEntry` rejects anything else. So no names, emails or free text, only ids, roles and settings.
   - **What happens on deletion:** deleting a user nulls their entries' actor (the foreign key action runs as the table owner), and deleting a tenant removes its entries.
   - **Actions so far:** `tenant.created`, `membership.role_changed`, `membership.removed`. Invites (S9) and every later write add theirs.
   - **Reading:** `GET /v1/audit-log` (owners and managers) pages newest first with a `before` cursor, since UUID v7 order is time order.
6. **Usage metering:** `usage_meters` (tenant, metric, `YYYY-MM` UTC month, amount) with an atomic `INSERT … ON CONFLICT DO UPDATE amount = amount + n`. Metrics: `llm_tokens`, `emails_sent`. Work that has a transaction meters inside it (`addUsage` + `usagePeriodOf(clock.now())`). Months are UTC, not the business's time zone, to keep billing periods simple. Nothing consumes the meters until Phase 5/6.
7. **At most 5 businesses per owner** (user, S8). `createTenant(…, { owner, ownerLimit })` counts the user's owned businesses in a user context and inserts the new one in the same transaction, under a per-user advisory lock. Concurrent sign-ups cannot exceed the limit (tested). Over the limit: 409 `business_limit_reached`.
8. **New endpoints.**
   - `GET /v1/members` (`members.read`).
   - `PATCH /v1/members/:userId` `{ role }` (`members.manage`).
   - `DELETE /v1/members/:userId`: anyone may remove themselves, which clears the session's business. Removing someone else needs `members.manage`, checked before any lookup, so staff cannot probe who is a member.
   - `GET /v1/audit-log` (`audit.read`).
   - New error codes: `forbidden`, `member_not_found`, `last_owner`, `business_limit_reached`.

9. **Ids are canonical lowercase.** `TenantIdSchema` and `UserIdSchema` lowercase what they parse. Postgres compares UUIDs case-insensitively but our code compares them as strings, so `DELETE /v1/members/<own id in capitals>` was not recognised as leaving (found in the S8 self-review, test first).

## Consequences
+ One rule set for the UI and the AI: Phase 6 tools call the same core services, which check permissions, apply the rules and write audit entries.
+ The audit log cannot be edited or erased by the application, and personal data cannot leak into it through `before`/`after`.
+ Concurrent team changes and concurrent business creation are race-free, and tests prove it.
− Core now depends on db and needs Postgres for its service tests. The pure rules stay in plain modules with 100% unit coverage.
− The matrix lists permissions that nothing enforces yet (bookings, clients, notes, settings). Each phase must wire its endpoints and AI tools to them; the traceability matrix tracks it.
− A business owner's audit log is visible to managers too. If owners want private entries (e.g. billing), we add an owner-only permission then.
− Invites (S9) are needed before a business can add members through the app. Until then members are added only by tests and the database.

## Alternatives considered
- **Permissions as RLS policies per role**: rejected for now. RLS stays tenant isolation; role and ownership rules need domain context (e.g. booking → staff → user) and readable denials for the AI. AC-W9-1 asks for enforcement "at API and RLS level". The API part is done here. The RLS part, a staff-scoped policy on bookings and notes, comes with those tables in Phase 3.
- **An audit trigger in Postgres**: rejected. It cannot know the actor, the request id or the action's meaning, and it would copy whole rows (personal data) into the log.
- **Domain services in the api**: rejected. AI tools could not reach them without depending on the api.
