-- The exact client email or phone the current transaction names, set by
-- `setTransactionClientContact` with set_config(..., true) when staff look a client up by it
-- or book the client they found (ADR-0020). NULL when unset. The clients `member_scope` policy
-- then also shows staff the clients with exactly that email or phone, read-only: its WITH
-- CHECK still lets only owners and managers write.
CREATE FUNCTION current_client_contact() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.client_contact', true), '') $$;
--> statement-breakpoint
ALTER POLICY "member_scope" ON "clients" TO public USING ((SELECT current_member_sees_all()) OR id IN (SELECT client_id FROM bookings) OR id IN (SELECT client_id FROM waitlist_entries) OR (SELECT current_client_contact()) IN (email, phone)) WITH CHECK ((SELECT current_member_sees_all()));