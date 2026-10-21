ALTER TYPE "public"."audit_actor_kind" ADD VALUE 'ai_on_behalf_of';--> statement-breakpoint
ALTER TYPE "public"."outbox_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "ai_action_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"proposal_id" uuid,
	"action" text NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"inverse" jsonb,
	"explanation" jsonb NOT NULL,
	"outbox_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"on_behalf_of_user_id" uuid,
	"record_owner_user_id" uuid,
	"undo_until" timestamp with time zone,
	"undone_by_user_id" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_action_executions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_action_executions_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "ai_action_executions_proposal_unique" UNIQUE("tenant_id","proposal_id"),
	CONSTRAINT "ai_action_executions_action_known" CHECK ("ai_action_executions"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk')),
	CONSTRAINT "ai_action_executions_tool_format" CHECK ("ai_action_executions"."tool" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
	CONSTRAINT "ai_action_executions_entity_type_format" CHECK ("ai_action_executions"."entity_type" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
	CONSTRAINT "ai_action_executions_outcome_known" CHECK ("ai_action_executions"."outcome" IN ('execute', 'execute_and_notify', 'propose')),
	CONSTRAINT "ai_action_executions_proposal_when_proposed" CHECK (("ai_action_executions"."outcome" = 'propose') = ("ai_action_executions"."proposal_id" IS NOT NULL)),
	CONSTRAINT "ai_action_executions_idempotency_key_format" CHECK ("ai_action_executions"."idempotency_key" ~ '^[A-Za-z0-9.:_-]{8,200}$'),
	CONSTRAINT "ai_action_executions_status_known" CHECK ("ai_action_executions"."status" IN ('done', 'undone')),
	CONSTRAINT "ai_action_executions_undone_when_undone" CHECK (("ai_action_executions"."status" = 'undone') = ("ai_action_executions"."undone_at" IS NOT NULL)),
	CONSTRAINT "ai_action_executions_undo_reason_known" CHECK ("ai_action_executions"."undo_reason" IS NULL OR ("ai_action_executions"."undo_reason" IN ('wrong', 'changed_mind', 'other') AND "ai_action_executions"."status" = 'undone')),
	CONSTRAINT "ai_action_executions_undo_needs_inverse" CHECK (("ai_action_executions"."inverse" IS NULL) = ("ai_action_executions"."undo_until" IS NULL)),
	CONSTRAINT "ai_action_executions_outbox_links" CHECK (cardinality("ai_action_executions"."outbox_message_ids") <= 100),
	CONSTRAINT "ai_action_executions_before_size" CHECK (octet_length("ai_action_executions"."before"::text) <= 8192),
	CONSTRAINT "ai_action_executions_after_size" CHECK (octet_length("ai_action_executions"."after"::text) <= 8192),
	CONSTRAINT "ai_action_executions_inverse_size" CHECK (octet_length("ai_action_executions"."inverse"::text) <= 8192),
	CONSTRAINT "ai_action_executions_explanation_size" CHECK (octet_length("ai_action_executions"."explanation"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "ai_action_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_action_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"action" text NOT NULL,
	"tool" text NOT NULL,
	"target_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"explanation" jsonb NOT NULL,
	"requested_by_user_id" uuid,
	"record_owner_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_action_proposals_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_action_proposals_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "ai_action_proposals_action_known" CHECK ("ai_action_proposals"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk')),
	CONSTRAINT "ai_action_proposals_tool_format" CHECK ("ai_action_proposals"."tool" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
	CONSTRAINT "ai_action_proposals_target_key_format" CHECK ("ai_action_proposals"."target_key" ~ '^[A-Za-z0-9.:_-]{1,200}$'),
	CONSTRAINT "ai_action_proposals_idempotency_key_format" CHECK ("ai_action_proposals"."idempotency_key" ~ '^[A-Za-z0-9.:_-]{8,200}$'),
	CONSTRAINT "ai_action_proposals_status_known" CHECK ("ai_action_proposals"."status" IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
	CONSTRAINT "ai_action_proposals_fingerprint_format" CHECK ("ai_action_proposals"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_action_proposals_decided_when_not_pending" CHECK (("ai_action_proposals"."status" = 'pending') = ("ai_action_proposals"."decided_at" IS NULL)),
	CONSTRAINT "ai_action_proposals_expires_after_created" CHECK ("ai_action_proposals"."expires_at" > "ai_action_proposals"."created_at"),
	CONSTRAINT "ai_action_proposals_payload_size" CHECK (octet_length("ai_action_proposals"."payload"::text) <= 8192),
	CONSTRAINT "ai_action_proposals_preview_size" CHECK (octet_length("ai_action_proposals"."preview"::text) <= 8192),
	CONSTRAINT "ai_action_proposals_explanation_size" CHECK (octet_length("ai_action_proposals"."explanation"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "autonomy_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"ask_first" boolean DEFAULT false NOT NULL,
	"levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_settings_tenant_unique" UNIQUE("tenant_id"),
	CONSTRAINT "autonomy_settings_levels_known" CHECK (jsonb_typeof("autonomy_settings"."levels") = 'object' AND "autonomy_settings"."levels" - ARRAY['booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', 'client_note.save', 'task.create', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk'] = '{}'::jsonb AND NOT jsonb_path_exists("autonomy_settings"."levels", '$.* ? (@ != "ask" && @ != "notify" && @ != "auto")')),
	CONSTRAINT "autonomy_settings_bulk_never_auto" CHECK ("autonomy_settings"."levels"->>'message.bulk' IS DISTINCT FROM 'auto')
);
--> statement-breakpoint
ALTER TABLE "autonomy_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_system_has_no_user";--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_undone_by_user_id_users_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."ai_action_proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "autonomy_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "autonomy_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_action_executions_recent_idx" ON "ai_action_executions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_action_executions_entity_idx" ON "ai_action_executions" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ai_action_executions_on_behalf_of_user_id_idx" ON "ai_action_executions" USING btree ("on_behalf_of_user_id");--> statement-breakpoint
CREATE INDEX "ai_action_executions_undone_by_user_id_idx" ON "ai_action_executions" USING btree ("undone_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_action_proposals_one_pending_per_target" ON "ai_action_proposals" USING btree ("tenant_id","target_key") WHERE "ai_action_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ai_action_proposals_requested_by_idx" ON "ai_action_proposals" USING btree ("tenant_id","requested_by_user_id");--> statement-breakpoint
CREATE INDEX "ai_action_proposals_requested_by_user_id_idx" ON "ai_action_proposals" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "ai_action_proposals_decided_by_user_id_idx" ON "ai_action_proposals" USING btree ("decided_by_user_id");--> statement-breakpoint
CREATE INDEX "ai_action_proposals_pending_expiry_idx" ON "ai_action_proposals" USING btree ("expires_at") WHERE "ai_action_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "autonomy_settings_updated_by_user_id_idx" ON "autonomy_settings" USING btree ("updated_by_user_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_system_has_no_user" CHECK ("audit_log"."actor_kind" <> 'system' OR "audit_log"."actor_user_id" IS NULL);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_action_executions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "ai_action_executions" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR on_behalf_of_user_id = current_user_id()) WITH CHECK ((SELECT current_member_sees_all()) OR on_behalf_of_user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_action_proposals" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "ai_action_proposals" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR requested_by_user_id = current_user_id()) WITH CHECK ((SELECT current_member_sees_all()) OR requested_by_user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_settings" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope_insert" ON "autonomy_settings" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "member_scope_update" ON "autonomy_settings" AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "member_scope_delete" ON "autonomy_settings" AS RESTRICTIVE FOR DELETE TO public USING ((SELECT current_member_sees_all()));