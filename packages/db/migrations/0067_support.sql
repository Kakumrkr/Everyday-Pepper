CREATE TABLE "public_support_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"body" text NOT NULL,
	"page" text,
	"topic" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_support_requests_reference_unique" UNIQUE("reference"),
	CONSTRAINT "public_support_requests_reference_format" CHECK ("public_support_requests"."reference" ~ '^PEP-[0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "public_support_requests_email_length" CHECK (length("public_support_requests"."email") BETWEEN 3 AND 254),
	CONSTRAINT "public_support_requests_name_length" CHECK ("public_support_requests"."name" IS NULL OR length("public_support_requests"."name") BETWEEN 1 AND 100),
	CONSTRAINT "public_support_requests_body_length" CHECK (length("public_support_requests"."body") BETWEEN 1 AND 4000),
	CONSTRAINT "public_support_requests_page_length" CHECK ("public_support_requests"."page" IS NULL OR length("public_support_requests"."page") <= 200),
	CONSTRAINT "public_support_requests_topic_length" CHECK ("public_support_requests"."topic" IS NULL OR length("public_support_requests"."topic") <= 80)
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_author_known" CHECK ("support_messages"."author_kind" IN ('member', 'pepper')),
	CONSTRAINT "support_messages_pepper_has_no_user" CHECK ("support_messages"."author_kind" = 'member' OR "support_messages"."author_user_id" IS NULL),
	CONSTRAINT "support_messages_body_length" CHECK (length("support_messages"."body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "support_reads_thread_user_unique" UNIQUE("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "support_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'waiting_on_pepper' NOT NULL,
	"opened_by_user_id" uuid,
	"context" jsonb NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"solved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_threads_reference_unique" UNIQUE("reference"),
	CONSTRAINT "support_threads_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_threads_reference_format" CHECK ("support_threads"."reference" ~ '^PEP-[0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "support_threads_kind_known" CHECK ("support_threads"."kind" IN ('problem', 'question', 'idea')),
	CONSTRAINT "support_threads_status_known" CHECK ("support_threads"."status" IN ('waiting_on_pepper', 'pepper_replied', 'solved')),
	CONSTRAINT "support_threads_solved_at" CHECK (("support_threads"."status" = 'solved') = ("support_threads"."solved_at" IS NOT NULL)),
	CONSTRAINT "support_threads_context_size" CHECK (jsonb_typeof("support_threads"."context") = 'object' AND length("support_threads"."context"::text) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "support_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."support_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_reads" ADD CONSTRAINT "support_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_reads" ADD CONSTRAINT "support_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_reads" ADD CONSTRAINT "support_reads_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."support_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_support_requests_created_idx" ON "public_support_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_messages_thread_idx" ON "support_messages" USING btree ("tenant_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "support_messages_author_idx" ON "support_messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "support_reads_user_idx" ON "support_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_threads_recent_idx" ON "support_threads" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE INDEX "support_threads_opened_by_idx" ON "support_threads" USING btree ("opened_by_user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_messages" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "support_messages" AS RESTRICTIVE FOR ALL TO public USING (thread_id IN (SELECT id FROM support_threads)) WITH CHECK (thread_id IN (SELECT id FROM support_threads));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_reads" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "support_reads" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_threads" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "support_threads" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR opened_by_user_id = current_user_id()) WITH CHECK ((SELECT current_member_sees_all()) OR opened_by_user_id = current_user_id());--> statement-breakpoint
-- Hardening (S59, PCR-010), beyond what drizzle-kit expresses: RLS applies to the table owner
-- too, as for every tenant-owned table (ADR-0010); messages are append-only for the services
-- (they go with their thread, the business or the account through the foreign keys).
ALTER TABLE "support_threads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "support_messages" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "support_threads_set_updated_at" BEFORE UPDATE ON "support_threads"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
