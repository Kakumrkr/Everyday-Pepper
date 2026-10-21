ALTER TABLE "ai_action_executions" ADD COLUMN "requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD COLUMN "tool_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_action_executions_requested_by_user_id_idx" ON "ai_action_executions" USING btree ("requested_by_user_id");--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_summary_length" CHECK ("ai_action_executions"."summary" IS NULL OR char_length("ai_action_executions"."summary") <= 600);--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_tool_version_positive" CHECK ("ai_action_proposals"."tool_version" >= 1);--> statement-breakpoint
ALTER POLICY "member_scope" ON "ai_action_executions" TO public USING ((SELECT current_member_sees_all()) OR on_behalf_of_user_id = current_user_id() OR requested_by_user_id = current_user_id()) WITH CHECK ((SELECT current_member_sees_all()) OR on_behalf_of_user_id = current_user_id() OR requested_by_user_id = current_user_id());--> statement-breakpoint
-- S26 (ADR-0031): receipts recorded before this migration answered the member they were done
-- for, or the member whose proposal was approved.
UPDATE "ai_action_executions" AS e
SET "requested_by_user_id" = COALESCE(
  (SELECT p."requested_by_user_id" FROM "ai_action_proposals" AS p
   WHERE p."tenant_id" = e."tenant_id" AND p."id" = e."proposal_id"),
  e."on_behalf_of_user_id");
--> statement-breakpoint
-- The proposal's tool version and the receipt's requester and summary are part of what was
-- shown and done: they never change (the requester only clears when their account is deleted).
CREATE OR REPLACE FUNCTION ai_action_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.action, NEW.tool, NEW.tool_version, NEW.target_key,
      NEW.idempotency_key, NEW.payload, NEW.preview, NEW.fingerprint, NEW.explanation,
      NEW.record_owner_user_id, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.action, OLD.tool, OLD.tool_version, OLD.target_key,
      OLD.idempotency_key, OLD.payload, OLD.preview, OLD.fingerprint, OLD.explanation,
      OLD.record_owner_user_id, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'an AI proposal cannot be changed once written' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     AND NEW.requested_by_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'an AI proposal cannot change hands' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'an AI proposal is decided only once' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
          OR (NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
              AND NEW.decided_by_user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'an AI proposal is decided only once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai_action_executions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.proposal_id, NEW.action, NEW.tool, NEW.outcome,
      NEW.idempotency_key, NEW.entity_type, NEW.entity_id, NEW.before, NEW.after, NEW.inverse,
      NEW.explanation, NEW.outbox_message_ids, NEW.record_owner_user_id, NEW.undo_until,
      NEW.summary, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.proposal_id, OLD.action, OLD.tool, OLD.outcome,
      OLD.idempotency_key, OLD.entity_type, OLD.entity_id, OLD.before, OLD.after, OLD.inverse,
      OLD.explanation, OLD.outbox_message_ids, OLD.record_owner_user_id, OLD.undo_until,
      OLD.summary, OLD.created_at) THEN
    RAISE EXCEPTION 'an AI action receipt cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.on_behalf_of_user_id IS DISTINCT FROM OLD.on_behalf_of_user_id
      AND NEW.on_behalf_of_user_id IS NOT NULL)
     OR (NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
         AND NEW.requested_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'an AI action cannot change hands' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'undone'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.undone_at IS DISTINCT FROM OLD.undone_at
          OR NEW.undo_reason IS DISTINCT FROM OLD.undo_reason
          OR (NEW.undone_by_user_id IS DISTINCT FROM OLD.undone_by_user_id
              AND NEW.undone_by_user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'an AI action is undone only once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
