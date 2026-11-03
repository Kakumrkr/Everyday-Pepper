-- Staff walk-in clients (S50.2, ADR-0052). Staff still never write clients through the
-- `member_scope` policy (ADR-0017); a staff member books a walk-in through
-- `create_walk_in_client`, which adds the client inside the transaction that books them, and
-- a commit-time check refuses a transaction that added a walk-in without booking them. The
-- client is then the staff member's through that booking, as any client is. The id comes
-- from the app (UUIDv7, as every id).
CREATE FUNCTION create_walk_in_client(p_id uuid, p_name text, p_email text, p_phone text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
  added uuid;
BEGIN
  IF current_user_id() IS NULL OR NOT EXISTS (SELECT 1 FROM current_member_staff_ids()) THEN
    RAISE EXCEPTION 'only a staff member of the business adds a walk-in' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.user_id', '', true);
  INSERT INTO clients (id, tenant_id, name, email, phone, source)
       VALUES (p_id, current_tenant_id(), p_name, p_email, p_phone, 'team')
    RETURNING id INTO added;
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  PERFORM set_config('pepper.walk_in_clients',
    COALESCE(current_setting('pepper.walk_in_clients', true), '') || added::text || ',', true);
  RETURN added;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION create_walk_in_client(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_walk_in_client(uuid, text, text, text) TO pepper_app;
--> statement-breakpoint
-- At commit: every walk-in the transaction added has a booking, or nothing is committed.
CREATE FUNCTION clients_walk_in_booked() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
  booked boolean;
BEGIN
  IF position(NEW.id::text || ',' IN COALESCE(current_setting('pepper.walk_in_clients', true), '')) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.user_id', '', true);
  booked := EXISTS (SELECT 1 FROM bookings WHERE tenant_id = NEW.tenant_id AND client_id = NEW.id);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  IF NOT booked THEN
    RAISE EXCEPTION 'a walk-in client is added only with their booking' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION clients_walk_in_booked() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER clients_walk_in_booked AFTER INSERT ON clients
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source = 'team') EXECUTE FUNCTION clients_walk_in_booked();
