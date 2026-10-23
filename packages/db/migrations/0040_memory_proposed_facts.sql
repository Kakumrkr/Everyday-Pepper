-- Facts the AI proposed (S30, ADR-0035): a save waiting for a person's OK is stored as a
-- `proposed` fact, so its value never sits in the proposal itself (playbook principle 7). Such a
-- fact was never remembered: when it goes (approved and merged into the subject's current fact,
-- turned down, or cleaned up once its proposal expired), nothing is scrubbed. The words it came
-- from are the member's own chat, as for any message. Deleting an active fact still forgets it
-- everywhere, as before.
CREATE OR REPLACE FUNCTION memory_facts_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  member text := current_setting('app.user_id', true);
BEGIN
  IF OLD.status = 'proposed' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('app.user_id', '', true);
  PERFORM memory_scrub(OLD.tenant_id, OLD.value, OLD.created_at, OLD.source_turn_id);
  PERFORM memory_scrub(OLD.tenant_id, OLD.previous_value, OLD.created_at, OLD.source_turn_id);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_facts_forget() FROM PUBLIC;
