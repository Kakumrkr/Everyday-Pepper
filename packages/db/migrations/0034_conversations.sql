CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replay" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_call_id" text,
	"tool_name" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"card" jsonb,
	"step" smallint,
	"untrusted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_messages_seq_unique" UNIQUE("tenant_id","conversation_id","seq"),
	CONSTRAINT "conversation_messages_tool_result_unique" UNIQUE("tenant_id","turn_id","step","tool_call_id"),
	CONSTRAINT "conversation_messages_role_known" CHECK ("conversation_messages"."role" IN ('user', 'assistant', 'tool')),
	CONSTRAINT "conversation_messages_seq_positive" CHECK ("conversation_messages"."seq" >= 1),
	CONSTRAINT "conversation_messages_content_size" CHECK (length("conversation_messages"."content") <= 100000),
	CONSTRAINT "conversation_messages_tool_fields" CHECK (("conversation_messages"."role" = 'tool') = ("conversation_messages"."tool_call_id" IS NOT NULL AND "conversation_messages"."tool_name" IS NOT NULL) AND ("conversation_messages"."role" = 'user') = ("conversation_messages"."step" IS NULL)),
	CONSTRAINT "conversation_messages_tool_calls_only_assistant" CHECK (jsonb_typeof("conversation_messages"."tool_calls") = 'array' AND ("conversation_messages"."role" = 'assistant' OR "conversation_messages"."tool_calls" = '[]'::jsonb) AND jsonb_array_length("conversation_messages"."tool_calls") <= 32),
	CONSTRAINT "conversation_messages_replay_only_assistant" CHECK (jsonb_typeof("conversation_messages"."replay") = 'array' AND ("conversation_messages"."role" = 'assistant' OR "conversation_messages"."replay" = '[]'::jsonb)),
	CONSTRAINT "conversation_messages_card_only_tool" CHECK ("conversation_messages"."card" IS NULL OR "conversation_messages"."role" = 'tool'),
	CONSTRAINT "conversation_messages_card_size" CHECK (octet_length("conversation_messages"."card"::text) <= 32768),
	CONSTRAINT "conversation_messages_tool_name_format" CHECK ("conversation_messages"."tool_name" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "conversation_messages_tool_call_id_size" CHECK (length("conversation_messages"."tool_call_id") <= 200),
	CONSTRAINT "conversation_messages_step_range" CHECK ("conversation_messages"."step" BETWEEN 1 AND 99)
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_turn_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stop_reason" text,
	"untrusted" boolean DEFAULT false NOT NULL,
	"steps" smallint DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turns_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_turns_client_turn_unique" UNIQUE("tenant_id","user_id","client_turn_id"),
	CONSTRAINT "conversation_turns_status_known" CHECK ("conversation_turns"."status" IN ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "conversation_turns_stop_reason_known" CHECK ("conversation_turns"."stop_reason" IN ('answered', 'step_limit', 'time_limit', 'write_limit', 'provider_unavailable', 'provider_refused', 'budget_exhausted', 'ai_off', 'cancelled', 'interrupted', 'internal')),
	CONSTRAINT "conversation_turns_finished_when_done" CHECK (("conversation_turns"."status" = 'running') = ("conversation_turns"."finished_at" IS NULL) AND ("conversation_turns"."status" = 'running') = ("conversation_turns"."stop_reason" IS NULL)),
	CONSTRAINT "conversation_turns_steps_range" CHECK ("conversation_turns"."steps" BETWEEN 0 AND 99),
	CONSTRAINT "conversation_turns_tokens_not_negative" CHECK ("conversation_turns"."input_tokens" >= 0 AND "conversation_turns"."cached_input_tokens" >= 0 AND "conversation_turns"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text DEFAULT 'chat' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversations_channel_known" CHECK ("conversations"."channel" IN ('chat', 'voice'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_turn_fk" FOREIGN KEY ("tenant_id","turn_id") REFERENCES "public"."conversation_turns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_turn_idx" ON "conversation_messages" USING btree ("tenant_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_one_running" ON "conversation_turns" USING btree ("tenant_id","conversation_id") WHERE "conversation_turns"."status" = 'running';--> statement-breakpoint
CREATE INDEX "conversation_turns_conversation_idx" ON "conversation_turns" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_member_recent_idx" ON "conversations" USING btree ("tenant_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_retention_idx" ON "conversations" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_messages" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "conversation_messages" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_turns" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "conversation_turns" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "conversations" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());