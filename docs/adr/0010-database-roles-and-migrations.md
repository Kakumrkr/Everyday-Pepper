# ADR-0010: Database roles, migrations and the tenant context

- **Status:** Proposed (Claude default in S6, user to confirm) · **Date:** 2026-10-16 · Builds on ADR-0002 and ADR-0008

## Context
ADR-0002 decided on row-level security (RLS) keyed on `app.tenant_id`, an app role without `BYPASSRLS`, and a separate migration role. Until S6 every process connected as the Compose superuser, which RLS never applies to. We need concrete roles, a way to create them in dev, CI and the pilot, a safe way to set the tenant per transaction, and tests that fail when isolation is missing.

## Decision
- **Three roles.**
  - The **migration role** (`MIGRATION_DATABASE_URL`; in Compose, the `POSTGRES_USER` superuser) owns the schema and runs migrations. It needs `CREATEROLE`.
  - **`floty_app`** (NOLOGIN, created by migration 0000) holds the services' privileges: `USAGE` on `public`, plus `SELECT/INSERT/UPDATE/DELETE` on every table, granted through default privileges.
  - The **services' login role** (`DATABASE_URL`, `floty_service` in Compose) is a member of `floty_app`. It is not a superuser, has no `BYPASSRLS`/`CREATEROLE`/`CREATEDB`, and owns nothing.
- **Provisioning.**
  - `prepareDatabase` (the `migrate` CLI, Compose's one-shot `migrate` service, `pnpm db:migrate`) applies migrations, then creates or updates the login role from `DATABASE_URL`'s user and password.
  - It refuses to touch a role that has elevated attributes, so a misconfigured URL fails instead of demoting an admin.
  - Managed databases may create the login role another way; the code needs only the URL.
- **Readiness fails** when the services' connection is a superuser or `BYPASSRLS` role, so a misconfiguration cannot silently disable isolation.
- **Tenant context.**
  - `withTenant(db, tenantId, work)` opens a transaction and runs `set_config('app.tenant_id', $1, true)`, which is `SET LOCAL` with a bound parameter.
  - Policies call `current_tenant_id()` = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Once a pooled connection has used the setting, it reads `''` outside a transaction rather than NULL; `NULLIF` makes that match nothing instead of raising an error.
  - A malformed value raises an error, so the query fails closed.
- **Policies.**
  - Every tenant-owned table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and exactly one policy, `tenant_isolation`: `FOR ALL USING (tenant_id = current_tenant_id()) WITH CHECK (same)`. On `tenants` the column is `id`.
  - `tenant_id` defaults to `current_tenant_id()`, so repositories never take a tenant id.
  - A tenant is created by generating its id and inserting the row inside `withTenant(newId)`.
- **Migrations.**
  - drizzle-kit generates the table DDL and policies from `src/schema.ts`. What it cannot express (roles, functions, `FORCE`, triggers) goes in custom SQL migrations.
  - Migrations are applied by `runMigrations` (drizzle's migrator, all pending migrations in one transaction, serialised by an advisory lock), never by drizzle-kit against a database.
  - An integration test fails when `schema.ts` has changes with no migration generated for them.
- **IDs** are UUID v7, generated in the app (`uuid` package) because Postgres 17 has no `uuidv7()`.
- **Isolation suite** (`packages/db/src/isolation.int.test.ts`).
  - Every table in `public` must be listed as tenant-owned (with a seed function) or global (with a reason).
  - Tenant-owned tables are checked for forced RLS and the exact policy, then attacked across tenants: read by id, update, delete, insert into and move to another tenant, no context, and a pooled connection after commit or rollback.
  - The services' role is checked too: it cannot disable RLS, drop policies, create tables, `SET ROLE` to the owner, or turn `row_security` off.

## Consequences
+ Isolation is enforced by Postgres for every query, and the suite fails for any new table that lacks it.
+ Compose, CI and the Testcontainers tests all use the same roles and migration path.
− Provisioning sends the login password in a `CREATE/ALTER ROLE` statement, which Postgres may log if statement logging is on. Acceptable for dev and pilot; use managed-identity auth or out-of-band provisioning on AWS.
− Cross-tenant lookups (finding a user's tenants at sign-in, the public booking page's slug lookup) cannot run as the services' role. They will need narrowly scoped `SECURITY DEFINER` functions or a user-keyed policy (S7, Phase 4), each covered by the suite.
− The `tenants.slug` unique constraint reveals across tenants that a slug is taken. Slugs are public anyway.
