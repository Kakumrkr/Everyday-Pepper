-- Hardening of the trust layer (ADR-0028), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "autonomy_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_action_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_action_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "autonomy_settings_set_updated_at" BEFORE UPDATE ON "autonomy_settings"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ai_action_proposals_set_updated_at" BEFORE UPDATE ON "ai_action_proposals"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ai_action_executions_set_updated_at" BEFORE UPDATE ON "ai_action_executions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Proposals and executions are receipts: the services may not delete them. Deleting a tenant
-- still cascades, because foreign key actions run as the table owner.
REVOKE DELETE, TRUNCATE ON "ai_action_proposals" FROM pepper_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "ai_action_executions" FROM pepper_app;
--> statement-breakpoint
-- What a member approves is what runs: once a proposal is written, only its decision may
-- change, once, from pending. Its members may still be cleared when their accounts are deleted.
CREATE FUNCTION ai_action_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.action, NEW.tool, NEW.target_key, NEW.idempotency_key,
      NEW.payload, NEW.preview, NEW.fingerprint, NEW.explanation, NEW.record_owner_user_id,
      NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.action, OLD.tool, OLD.target_key, OLD.idempotency_key,
      OLD.payload, OLD.preview, OLD.fingerprint, OLD.explanation, OLD.record_owner_user_id,
      OLD.expires_at, OLD.created_at) THEN
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
CREATE TRIGGER "ai_action_proposals_guard" BEFORE UPDATE ON "ai_action_proposals"
  FOR EACH ROW EXECUTE FUNCTION ai_action_proposals_guard();
--> statement-breakpoint
-- An execution's receipt never changes; it can be undone once.
CREATE FUNCTION ai_action_executions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.proposal_id, NEW.action, NEW.tool, NEW.outcome,
      NEW.idempotency_key, NEW.entity_type, NEW.entity_id, NEW.before, NEW.after, NEW.inverse,
      NEW.explanation, NEW.outbox_message_ids, NEW.record_owner_user_id, NEW.undo_until,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.proposal_id, OLD.action, OLD.tool, OLD.outcome,
      OLD.idempotency_key, OLD.entity_type, OLD.entity_id, OLD.before, OLD.after, OLD.inverse,
      OLD.explanation, OLD.outbox_message_ids, OLD.record_owner_user_id, OLD.undo_until,
      OLD.created_at) THEN
    RAISE EXCEPTION 'an AI action receipt cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.on_behalf_of_user_id IS DISTINCT FROM OLD.on_behalf_of_user_id
     AND NEW.on_behalf_of_user_id IS NOT NULL THEN
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
--> statement-breakpoint
CREATE TRIGGER "ai_action_executions_guard" BEFORE UPDATE ON "ai_action_executions"
  FOR EACH ROW EXECUTE FUNCTION ai_action_executions_guard();
