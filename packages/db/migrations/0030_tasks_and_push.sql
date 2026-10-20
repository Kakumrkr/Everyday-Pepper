ALTER TYPE "public"."outbox_message_type" ADD VALUE 'push';--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("tenant_id","endpoint"),
	CONSTRAINT "push_subscriptions_endpoint_format" CHECK ("push_subscriptions"."endpoint" ~ '^https://' AND length("push_subscriptions"."endpoint") <= 1000),
	CONSTRAINT "push_subscriptions_p256dh_format" CHECK ("push_subscriptions"."p256dh" ~ '^[A-Za-z0-9_-]{80,100}$'),
	CONSTRAINT "push_subscriptions_auth_format" CHECK ("push_subscriptions"."auth" ~ '^[A-Za-z0-9_-]{16,32}$')
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"due_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tasks_title_length" CHECK (length("tasks"."title") BETWEEN 1 AND 200),
	CONSTRAINT "tasks_status_known" CHECK ("tasks"."status" IN ('open', 'done')),
	CONSTRAINT "tasks_source_known" CHECK ("tasks"."source" IN ('manual', 'ai', 'system')),
	CONSTRAINT "tasks_completed_when_done" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tasks_open_idx" ON "tasks" USING btree ("tenant_id","due_at") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("tenant_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_id_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "tasks_due_scan_idx" ON "tasks" USING btree ("due_at") WHERE "tasks"."status" = 'open' AND "tasks"."due_at" IS NOT NULL AND "tasks"."due_notified_at" IS NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "push_subscriptions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "push_subscriptions" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tasks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "tasks" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR assignee_user_id = current_user_id() OR created_by_user_id = current_user_id()) WITH CHECK ((SELECT current_member_sees_all()) OR assignee_user_id = current_user_id() OR created_by_user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "job_scan" ON "tasks" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('tasks'));