CREATE TABLE "booking_funnel_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"visit_id" uuid NOT NULL,
	"step" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_funnel_events_visit_step_unique" UNIQUE("tenant_id","visit_id","step"),
	CONSTRAINT "booking_funnel_events_step_known" CHECK (step IN ('service', 'staff', 'time', 'details', 'verify', 'done', 'waitlisted'))
);
--> statement-breakpoint
ALTER TABLE "booking_funnel_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "remembered_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remembered_devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "remembered_devices_email_format" CHECK ("remembered_devices"."email" = lower("remembered_devices"."email") AND length("remembered_devices"."email") BETWEEN 3 AND 254 AND "remembered_devices"."email" LIKE '%_@_%'),
	CONSTRAINT "remembered_devices_token_hash_format" CHECK ("remembered_devices"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "remembered_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_funnel_events" ADD CONSTRAINT "booking_funnel_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_funnel_events_occurred_idx" ON "booking_funnel_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "remembered_devices_expires_idx" ON "remembered_devices" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_funnel_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "remembered_devices" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "remembered_devices" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL) WITH CHECK (current_user_id() IS NULL);--> statement-breakpoint
-- Hardening (S47, ADR-0047), beyond what drizzle-kit expresses. RLS applies to the table owner
-- too (as for every tenant-owned table, ADR-0010); the funnel's events are append-only for the
-- services (a business's deletion removes them through the foreign key).
ALTER TABLE "remembered_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_funnel_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "booking_funnel_events" FROM pepper_app;
