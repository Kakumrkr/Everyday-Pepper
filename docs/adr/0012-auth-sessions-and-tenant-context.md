# ADR-0012: Auth wiring — Better Auth tables, session tenant context, web forwarding

- **Status:** Proposed (2026-10-17, Claude, S7) — user to accept · **Date:** 2026-10-17 · Builds on ADR-0007 (Better Auth) and ADR-0010 (roles, `withTenant`)

## Context
ADR-0007 chose Better Auth for identity, with MFA for owners and memberships in our own tables. S7 had to decide how it fits the database rules of ADR-0010 (RLS everywhere, only `@floty/db` touches Postgres), how a request gets its tenant, how a signed-in user finds their businesses across tenants (RLS hides other tenants' memberships), and how the browser reaches the api.

## Decision
1. **Auth tables are global and owned by Better Auth's Drizzle adapter, in `@floty/db`.** `users`, `sessions`, `accounts`, `verifications`, `two_factors`: plural, snake_case, UUID v7 ids from `newId`. They have no `tenant_id` and no RLS, because sign-in looks up users and sessions before any tenant is known. The isolation suite lists each in `GLOBAL_TABLES` with a reason. `authDatabaseAdapter(db)` is the only way Better Auth reaches the database. `memberships.user_id` gets a foreign key (cascade) and an index. Emails are stored lowercased (CHECK constraint).
2. **"My businesses" uses a user-keyed, read-only policy, not a `SECURITY DEFINER` function.** `current_user_id()` reads `app.user_id`, which is set by `withUser(db, userId, work)` in a **read-only** transaction. `member_read` policies (SELECT only) on `memberships` (`user_id = current_user_id()`) and `tenants` (the user's memberships) apply **only when no tenant is set**, so a tenant transaction never sees a user's other businesses. A `SECURITY DEFINER` function was rejected: with `FORCE ROW LEVEL SECURITY`, a function owned by a non-superuser owner is still filtered, so it would only work where the migration role is a superuser.
3. **The tenant of a request comes from the session.** Better Auth's session has an `active_tenant_id` column (`input: false`, so Better Auth's own endpoints cannot set it, as a test proves). The api sets it only after a membership check: `POST /v1/tenants` (the creator becomes owner) and `PUT /v1/me/active-tenant` (switching). A new session starts in the user's first business (a session-create hook).
4. **`TenantGuard` re-checks membership on every request** and applies `decideTenantAccess` (`@floty/core`). The outcomes are no active business (403 `no_active_tenant`), not a member (403 `not_a_member`), owner without a verified TOTP (403 `mfa_required`), or the context `{tenantId, userId, role}`. Removing a member takes effect on their next request. `user_id`/`tenant_id` are added to the request's log lines (`identifyRequest`).
5. **The browser talks to one origin.** The web app forwards `/api/auth/*` and `/v1/*` to the api at request time, so `API_INTERNAL_URL` stays a runtime setting and is not baked in at build time. Only allowlisted headers pass in each direction, every `Set-Cookie` is kept, and bodies are capped at 100 KB. Cookies are first-party (`floty.session_token`, HttpOnly, SameSite=Lax, Secure on https, `__Secure-` prefix), and no CORS is needed. `AUTH_BASE_URL` is that origin.
6. **CSRF.** Better Auth checks `Origin` on its endpoints. The api's `SameOriginGuard` requires `Origin` = `AUTH_BASE_URL` on every non-GET request. Better Auth turns its check off when `NODE_ENV=test`, so we pin `disableCSRFCheck`/`disableOriginCheck: false` and tests run what production runs.
7. **Better Auth settings.**
   - Email and password: at least 10 characters, max 128. There is no breached-password check yet, so 10 rather than 8.
   - Sign-up signs the user in automatically. Email verification and password reset wait for the email channel (Phase 5).
   - Change-email and delete-user are off.
   - Sessions last 7 days, refreshed daily, with no cookie cache (sign-out and switching apply at once).
   - TOTP with backup codes, through the two-factor plugin (account lockout after 10 failures).
   - Built-in rate limits stored in memory.
   - Telemetry off.
   - Better Auth's log lines go to the redacting logger.
8. **Packaging.** `.pnpmfile.cjs` keeps only Better Auth's `drizzle-orm` and `pg` optional peers. Without it, pnpm resolved its framework peers (next, react, vitest, playwright) from the workspace into the api's production install (api image 1.26 GB → 461 MB).

## Consequences
+ Tenant isolation stays enforced by Postgres. The only cross-tenant read is the user's own memberships, read-only, and the isolation suite attacks it (writes, colleagues' rows, tenant set at the same time, pooled connections, malformed settings).
+ Auth is replaceable behind `AuthService`; endpoints and guards depend only on it.
+ One origin keeps cookies simple, and the api can stay private behind the web app.
− **Rate limits** are per api instance (memory) and key on `x-forwarded-for`. Next.js keeps a client-sent `X-Forwarded-For`, so until an edge proxy overwrites it (Phase 11 deploy), a client can rotate addresses and avoid per-address limits (Better Auth's two-factor lockout still applies). Before running several api instances, move the limiter to Redis.
− Sign-up reveals whether an email is registered (Better Auth answers 422). Revisit with email verification (Phase 5).
− `POST /v1/tenants` has no per-user limit on businesses yet (metering/plans, S8+).
− Better Auth writes a few messages through its module-level logger to the console, bypassing ours. Seen so far: "Invalid origin", which carries no personal data.
− `.pnpmfile.cjs` must be updated if we ever use another Better Auth integration (e.g. its React client).
