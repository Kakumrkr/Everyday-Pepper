-- The user of the current transaction, set by `withUser` with set_config(..., true) for the
-- "my businesses" lookup (ADR-0012). NULL when unset, like current_tenant_id(). Used only by
-- the read-only member_read policies, which also require that no tenant is set.
CREATE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
