-- Whether the current transaction is the worker's scan for `job`, set by `withJobScan` with
-- set_config(..., true) (ADR-0025). Used only by the read-only job_scan policies (migration
-- 0028): booking_reminders for the reminder job, tenants for the clean-up job; both also
-- require that no tenant is set.
CREATE FUNCTION current_job_scan(job text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$ SELECT COALESCE(current_setting('app.job_scan', true) = job, false) $$;
