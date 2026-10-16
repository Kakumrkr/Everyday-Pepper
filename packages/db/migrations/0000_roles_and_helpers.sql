-- Platform foundations that drizzle-kit cannot express (ADR-0002, ADR-0010).
-- Runs as the migration (schema owner) role, which needs CREATEROLE.

-- The privileges of the services. The login role in DATABASE_URL is granted this role by
-- `provisionAppRole`; neither owns tables, is a superuser, or may bypass row-level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'floty_app') THEN
    CREATE ROLE floty_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
-- No one but the owner creates objects in public (already the default since Postgres 15).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO floty_app;
--> statement-breakpoint
-- Every table created by later migrations is readable and writable by the services, row access
-- still limited by its RLS policy (the isolation suite fails for a table without one).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO floty_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO floty_app;
--> statement-breakpoint
-- The tenant of the current transaction, set by `withTenant` with set_config(..., true).
-- NULL when unset: outside a transaction the setting reads '' once it has been used on the
-- connection, so NULLIF keeps a pooled connection from failing or matching anything.
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
