-- Hardening of conversations with the AI (ADR-0030), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_turns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "conversations_set_updated_at" BEFORE UPDATE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "conversation_turns_set_updated_at" BEFORE UPDATE ON "conversation_turns"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A turn and its messages belong to the conversation's member: the same user all the way down,
-- so a row can never be filed under someone else's conversation.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_member_unique"
  UNIQUE ("tenant_id", "id", "user_id");
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_member_unique"
  UNIQUE ("tenant_id", "id", "conversation_id", "user_id");
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_same_member_fk"
  FOREIGN KEY ("tenant_id", "conversation_id", "user_id")
  REFERENCES "conversations" ("tenant_id", "id", "user_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_same_member_fk"
  FOREIGN KEY ("tenant_id", "turn_id", "conversation_id", "user_id")
  REFERENCES "conversation_turns" ("tenant_id", "id", "conversation_id", "user_id")
  ON DELETE CASCADE;
--> statement-breakpoint
-- Messages are written once: what the model was sent is what the record says. Turns and
-- messages go only with their conversation (retention, or the member leaving); deletes
-- cascade as the table owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "conversation_messages" FROM pepper_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "conversation_turns" FROM pepper_app;
--> statement-breakpoint
-- A turn keeps its conversation, member and client id, and ends once: after that only its
-- member may be cleared.
CREATE FUNCTION conversation_turns_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.user_id, NEW.client_turn_id,
      NEW.deadline_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.user_id, OLD.client_turn_id,
      OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a conversation turn cannot change hands' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'running' AND
     (NEW.status, NEW.stop_reason, NEW.finished_at, NEW.untrusted, NEW.steps, NEW.input_tokens,
      NEW.cached_input_tokens, NEW.output_tokens)
     IS DISTINCT FROM
     (OLD.status, OLD.stop_reason, OLD.finished_at, OLD.untrusted, OLD.steps, OLD.input_tokens,
      OLD.cached_input_tokens, OLD.output_tokens) THEN
    RAISE EXCEPTION 'a conversation turn ends only once' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.untrusted AND NOT NEW.untrusted THEN
    RAISE EXCEPTION 'an untrusted turn stays untrusted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "conversation_turns_guard" BEFORE UPDATE ON "conversation_turns"
  FOR EACH ROW EXECUTE FUNCTION conversation_turns_guard();
--> statement-breakpoint
-- A message goes only into a running turn. A row for another business is left to the RLS
-- policy, which refuses it (42501) like on every tenant table.
CREATE FUNCTION conversation_messages_running_turn() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NOT DISTINCT FROM current_tenant_id() AND NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE tenant_id = NEW.tenant_id AND id = NEW.turn_id AND status = 'running'
  ) THEN
    RAISE EXCEPTION 'messages are added only to a running turn' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "conversation_messages_running_turn" BEFORE INSERT ON "conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_running_turn();
