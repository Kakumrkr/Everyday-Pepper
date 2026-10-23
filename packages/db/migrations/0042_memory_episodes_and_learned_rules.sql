-- Episodes know their facts (S31, ADR-0037). An episode summarises a conversation in the
-- routine model's words, so a forgotten value may come back reworded ("hair-dye allergy" for
-- "PPD") and the value scrub (migration 0039) would miss it, as it missed the AI's reworded
-- answers (ADR-0036). The episode job records the facts its conversation saved or recalled
-- (`fact_ids`), and forgetting any of them deletes the episode. One episode per conversation,
-- replaced when it continues; `last_turn_id` is the job's idempotency key. The outbox gets an
-- `episode` message: the job is queued with the turn that ended and runs when the chat is quiet.
-- The trust tables' checks learn the dial's new `rule.change` action (learned rules, S31).
ALTER TYPE "public"."outbox_message_type" ADD VALUE 'episode';--> statement-breakpoint
ALTER TABLE "ai_action_executions" DROP CONSTRAINT "ai_action_executions_action_known";--> statement-breakpoint
ALTER TABLE "ai_action_proposals" DROP CONSTRAINT "ai_action_proposals_action_known";--> statement-breakpoint
ALTER TABLE "autonomy_settings" DROP CONSTRAINT "autonomy_settings_levels_known";--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD COLUMN "fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD COLUMN "last_turn_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_episodes_conversation_unique" ON "memory_episodes" USING btree ("tenant_id","conversation_id") WHERE "memory_episodes"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_episodes_fact_ids_idx" ON "memory_episodes" USING gin ("fact_ids");--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_action_known" CHECK ("ai_action_executions"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk'));--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_action_known" CHECK ("ai_action_proposals"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk'));--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "autonomy_settings_levels_known" CHECK (jsonb_typeof("autonomy_settings"."levels") = 'object' AND "autonomy_settings"."levels" - ARRAY['booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk'] = '{}'::jsonb AND NOT jsonb_path_exists("autonomy_settings"."levels", '$.* ? (@ != "ask" && @ != "notify" && @ != "auto")'));--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD CONSTRAINT "memory_episodes_fact_count" CHECK (cardinality("memory_episodes"."fact_ids") <= 100);
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
  DELETE FROM memory_episodes
   WHERE tenant_id = OLD.tenant_id AND fact_ids @> ARRAY[OLD.id];
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION memory_facts_forget() FROM PUBLIC;
