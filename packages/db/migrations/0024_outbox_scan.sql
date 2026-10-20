-- Whether the current transaction is the worker's outbox relay, set by `withOutboxScan` with
-- set_config(..., true) (ADR-0024). Used only by the read-only outbox_scan policy on
-- outbox_dispatch (migration 0025), which also requires that no tenant is set.
CREATE FUNCTION current_outbox_scan() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$ SELECT COALESCE(current_setting('app.outbox_scan', true) = 'on', false) $$;
