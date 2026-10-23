-- Hardening of the memory tables (Phase 7, ADR-0034), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "memory_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_episodes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "memory_facts_set_updated_at" BEFORE UPDATE ON "memory_facts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A fact keeps its subject, origin and author (the author only goes when their account does);
-- a proposed fact may become active, never the other way round.
CREATE FUNCTION memory_facts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.subject_type, NEW.client_id, NEW.staff_member_id,
      NEW.service_id, NEW.booking_id, NEW.key, NEW.source, NEW.source_turn_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.subject_type, OLD.client_id, OLD.staff_member_id,
      OLD.service_id, OLD.booking_id, OLD.key, OLD.source, OLD.source_turn_id, OLD.created_at) THEN
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
CREATE TRIGGER "memory_facts_guard" BEFORE UPDATE ON "memory_facts"
  FOR EACH ROW EXECUTE FUNCTION memory_facts_guard();
--> statement-breakpoint
-- An episode is written once, by the episode job; it is only ever deleted.
REVOKE UPDATE, TRUNCATE ON "memory_episodes" FROM pepper_app;
--> statement-breakpoint
-- A regular expression matching `needle` as whole words, case-insensitively with the 'i'
-- flag: every character but letters, digits and spaces escaped, runs of spaces matching any
-- whitespace.
CREATE FUNCTION memory_needle_pattern(needle text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$
    SELECT '(?<![[:alnum:]_])'
        || regexp_replace(
             regexp_replace(btrim(needle), '([^[:alnum:][:space:]])', '\\\1', 'g'),
             '[[:space:]]+', '[[:space:]]+', 'g')
        || '(?![[:alnum:]_])'
  $$;
--> statement-breakpoint
-- `j` with `pattern` replaced by "[forgotten]" in every string value (never in keys, so a
-- card or tool call keeps its shape).
CREATE FUNCTION memory_scrub_jsonb(j jsonb, pattern text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'string' THEN
      RETURN to_jsonb(regexp_replace(j #>> '{}', pattern, '[forgotten]', 'gi'));
    WHEN 'array' THEN
      RETURN COALESCE(
        (SELECT jsonb_agg(memory_scrub_jsonb(e, pattern) ORDER BY i)
           FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, i)),
        '[]'::jsonb);
    WHEN 'object' THEN
      RETURN COALESCE(
        (SELECT jsonb_object_agg(k, memory_scrub_jsonb(v, pattern))
           FROM jsonb_each(j) AS t(k, v)),
        '{}'::jsonb);
    ELSE
      RETURN j;
  END CASE;
END;
$$;
--> statement-breakpoint
-- Forget everywhere (playbook principle 7): removes `needle` from the business's stored
-- conversations (every member's: what the model is sent again when a chat continues) and
-- deletes the episodes that mention it. In each conversation turn that held it, the text is
-- replaced by "[forgotten]" and the provider's opaque reasoning items are dropped (they may
-- hold it too; the message phase is kept). Values shorter than 3 characters are too ambiguous
-- to match and are left to their fact's deletion alone. Called only by the triggers below,
-- which run as the schema owner: messages and episodes are otherwise never updated.
CREATE FUNCTION memory_scrub(p_tenant uuid, needle text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
DECLARE
  plain text;
  escaped text;
BEGIN
  IF needle IS NULL OR length(btrim(needle)) < 3 THEN
    RETURN;
  END IF;
  plain := memory_needle_pattern(needle);
  -- The same value as it appears inside JSON text (quotes and backslashes escaped).
  escaped := memory_needle_pattern(substr(to_json(btrim(needle))::text, 2,
                                          length(to_json(btrim(needle))::text) - 2));
  UPDATE conversation_messages m
     SET content = regexp_replace(
                     regexp_replace(m.content, plain, '[forgotten]', 'gi'),
                     escaped, '[forgotten]', 'gi'),
         tool_calls = memory_scrub_jsonb(m.tool_calls, plain),
         card = memory_scrub_jsonb(m.card, plain),
         replay = COALESCE(
           (SELECT jsonb_agg(e) FROM jsonb_array_elements(m.replay) AS t(e)
             WHERE e ->> 'type' = 'pepper.message_phase'),
           '[]'::jsonb)
   WHERE m.tenant_id = p_tenant
     AND m.turn_id IN (
       SELECT h.turn_id FROM conversation_messages h
        WHERE h.tenant_id = p_tenant
          AND (h.content ~* plain OR h.content ~* escaped
               OR h.tool_calls::text ~* escaped OR h.card::text ~* escaped));
  DELETE FROM memory_episodes WHERE tenant_id = p_tenant AND summary ~* plain;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_scrub(uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- After a fact is deleted (by a member, with its client, staff member, service or visit, or by
-- Undo), its value and its Undo-window previous value are scrubbed in the same transaction.
-- Runs as the owner with the member scope lifted for the statement (every member's chats hold
-- the business's facts), always limited to the fact's own business. Nothing to do while the
-- whole business is being deleted.
CREATE FUNCTION memory_facts_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('app.user_id', '', true);
  PERFORM memory_scrub(OLD.tenant_id, OLD.value);
  PERFORM memory_scrub(OLD.tenant_id, OLD.previous_value);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_facts_forget() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "memory_facts_forget" AFTER DELETE ON "memory_facts"
  FOR EACH ROW EXECUTE FUNCTION memory_facts_forget();
--> statement-breakpoint
-- A client's deletion takes every member's episodes that name them (their facts go by key).
CREATE FUNCTION clients_forget_episodes() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('app.user_id', '', true);
  DELETE FROM memory_episodes
   WHERE tenant_id = OLD.tenant_id AND client_ids @> ARRAY[OLD.id];
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION clients_forget_episodes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "clients_forget_episodes" AFTER DELETE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION clients_forget_episodes();
