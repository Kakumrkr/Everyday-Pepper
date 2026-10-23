-- Forget takes the AI's answers that recalled the fact (S30b, ADR-0036, amends ADR-0034). The
-- value scrub (migration 0039) matches the value's words, but a model may reword what it read:
-- "6N + 20 vol, 35 min" came back as "6N with 20 volume, for 35 minutes" and stayed in the chat,
-- so the next request sent it again. Stored tool answers name facts by id (`{"$fact": id}`,
-- ADR-0035), so the turns that brought a fact to the model are known exactly. From the first
-- such answer on, every later AI answer in that conversation (it may repeat what it read from the
-- history) is replaced by a fixed text, and its reasoning items are dropped. The member's words,
-- the tool calls and answers (references, no values) and cards (read live) keep their place: the
-- value scrub still covers them word for word.
CREATE FUNCTION memory_forget_recalled(p_tenant uuid, fact uuid, since timestamptz)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE conversation_messages m
     SET content = CASE WHEN m.content = '' THEN ''
                        ELSE '[Removed: this answer used a fact that was deleted]' END,
         replay = COALESCE(
           (SELECT jsonb_agg(e) FROM jsonb_array_elements(m.replay) AS t(e)
             WHERE e ->> 'type' = 'pepper.message_phase'),
           '[]'::jsonb)
    FROM (SELECT r.conversation_id, min(r.seq) AS first_seq
            FROM conversation_messages r
           WHERE r.tenant_id = p_tenant
             AND r.role = 'tool'
             AND r.created_at >= since
             AND strpos(r.content, '"$fact":"' || fact::text || '"') > 0
           GROUP BY r.conversation_id) f
   WHERE m.tenant_id = p_tenant
     AND m.conversation_id = f.conversation_id
     AND m.role = 'assistant'
     AND m.seq > f.first_seq;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_forget_recalled(uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
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
  PERFORM memory_forget_recalled(OLD.tenant_id, OLD.id, OLD.created_at);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_facts_forget() FROM PUBLIC;
