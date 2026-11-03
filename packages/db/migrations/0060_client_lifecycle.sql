ALTER TABLE "clients" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_deleted_without_details" CHECK ("clients"."deleted_at" IS NULL OR ("clients"."email" IS NULL AND "clients"."phone" IS NULL AND cardinality("clients"."tags") = 0 AND "clients"."birthday_month" IS NULL AND "clients"."birthday_year" IS NULL));--> statement-breakpoint
-- Merging and deleting clients (S50, ADR-0051), beyond what drizzle-kit expresses.
--
-- A merge moves the merged client's facts onto the client kept: a fact keeps its subject
-- (migration 0039) except in that one move, which the transaction names in
-- `pepper.client_merge` ('<from>><to>') before re-pointing. Anything else stays refused.
CREATE OR REPLACE FUNCTION memory_facts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.subject_type, NEW.staff_member_id,
      NEW.service_id, NEW.booking_id, NEW.key, NEW.source, NEW.source_turn_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.subject_type, OLD.staff_member_id,
      OLD.service_id, OLD.booking_id, OLD.key, OLD.source, OLD.source_turn_id, OLD.created_at)
     OR (NEW.client_id IS DISTINCT FROM OLD.client_id
         AND (OLD.client_id IS NULL OR NEW.client_id IS NULL
              OR current_setting('pepper.client_merge', true) IS DISTINCT FROM
                 OLD.client_id::text || '>' || NEW.client_id::text)) THEN
    RAISE EXCEPTION 'a memory fact keeps its subject and origin' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     AND NEW.created_by_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'a memory fact keeps its author' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'an active memory fact stays active' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Every member's episodes that name the merged client name the kept one instead (episodes are
-- otherwise written once, migration 0039). Owners and managers only, inside their business.
CREATE FUNCTION client_merge_episodes(p_from uuid, p_to uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
BEGIN
  IF current_user_id() IS NULL OR NOT current_member_sees_all() THEN
    RAISE EXCEPTION 'only owners and managers merge clients' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM clients
       WHERE tenant_id = current_tenant_id() AND id IN (p_from, p_to)) <> 2 OR p_from = p_to THEN
    RAISE EXCEPTION 'no such clients to merge' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.user_id', '', true);
  UPDATE memory_episodes
     SET client_ids = ARRAY(SELECT DISTINCT c FROM unnest(array_replace(client_ids, p_from, p_to)) AS t(c))
   WHERE tenant_id = current_tenant_id() AND client_ids @> ARRAY[p_from];
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION client_merge_episodes(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION client_merge_episodes(uuid, uuid) TO pepper_app;
--> statement-breakpoint
-- Before a client's details are erased: every member's episodes that name them go, the booking
-- page's remembered browsers for their email go, and their name, email and phone are scrubbed from the business's stored conversations written since
-- the client was added (as a fact's value is, migration 0039: never older text, so adding and
-- deleting a client can't erase a word from older chats). Owners and managers only.
CREATE FUNCTION client_forget(p_client uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
  c clients%ROWTYPE;
BEGIN
  IF current_user_id() IS NULL OR NOT current_member_sees_all() THEN
    RAISE EXCEPTION 'only owners and managers delete clients' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM clients WHERE tenant_id = current_tenant_id() AND id = p_client;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such client' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.user_id', '', true);
  DELETE FROM memory_episodes
   WHERE tenant_id = c.tenant_id AND client_ids @> ARRAY[c.id];
  PERFORM memory_scrub(c.tenant_id, c.name, c.created_at, NULL);
  PERFORM memory_scrub(c.tenant_id, c.email, c.created_at, NULL);
  PERFORM memory_scrub(c.tenant_id, c.phone, c.created_at, NULL);
  -- The booking page's remembered browsers for their email (S47) forget them too.
  DELETE FROM remembered_devices WHERE tenant_id = c.tenant_id AND email = c.email;
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION client_forget(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION client_forget(uuid) TO pepper_app;
