-- The business slug the current transaction looks up, set by `withPublicTenant` with
-- set_config(..., true) while the public booking page finds its business before any tenant is
-- known (ADR-0022). NULL when unset, like current_tenant_id(). Used only by the read-only
-- public_lookup policy on tenants (migration 0022), which also requires that no tenant is set.
CREATE FUNCTION current_public_slug() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.public_slug', true), '') $$;
