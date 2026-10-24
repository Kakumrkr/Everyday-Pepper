CREATE TABLE "feed_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'suggestion' NOT NULL,
	"subject_key" text NOT NULL,
	"day" date NOT NULL,
	"dedupe_key" text NOT NULL,
	"audience_staff_id" uuid,
	"staff_member_id" uuid,
	"client_id" uuid,
	"booking_id" uuid,
	"service_id" uuid,
	"payload" jsonb NOT NULL,
	"action_proposal_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"acted_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "feed_items_dedupe_key_unique" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "feed_items_kind_known" CHECK ("feed_items"."kind" IN ('schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload', 'waitlist_match')),
	CONSTRAINT "feed_items_status_known" CHECK ("feed_items"."status" IN ('needs_ok', 'suggestion', 'done', 'dismissed', 'expired')),
	CONSTRAINT "feed_items_subject_key_format" CHECK ("feed_items"."subject_key" ~ '^(staff|client|booking):[0-9a-f-]{36}$'),
	CONSTRAINT "feed_items_dedupe_key_format" CHECK ("feed_items"."dedupe_key" = "feed_items"."kind" || ':' || "feed_items"."subject_key" || ':' || "feed_items"."day"::text),
	CONSTRAINT "feed_items_payload_object" CHECK (jsonb_typeof("feed_items"."payload") = 'object'),
	CONSTRAINT "feed_items_payload_size" CHECK (octet_length("feed_items"."payload"::text) <= 2048),
	CONSTRAINT "feed_items_acted_when_closed" CHECK (("feed_items"."status" IN ('done', 'dismissed', 'expired')) = ("feed_items"."acted_at" IS NOT NULL)),
	CONSTRAINT "feed_items_snoozed_when_dismissed" CHECK ("feed_items"."snoozed_until" IS NULL OR "feed_items"."status" = 'dismissed')
);
--> statement-breakpoint
ALTER TABLE "feed_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "insight_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"run_count" bigint DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insight_runs_tenant_unique" UNIQUE("tenant_id"),
	CONSTRAINT "insight_runs_counts" CHECK ("insight_runs"."request_count" >= 0 AND "insight_runs"."run_count" >= 0 AND "insight_runs"."run_count" <= "insight_runs"."request_count")
);
--> statement-breakpoint
ALTER TABLE "insight_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "rebook_after_days" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "feed_settings" jsonb DEFAULT '{"suggestionsPaused": false, "disabledKinds": [], "answeredKinds": []}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_audience_staff_fk" FOREIGN KEY ("tenant_id","audience_staff_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_runs" ADD CONSTRAINT "insight_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_items_open_idx" ON "feed_items" USING btree ("tenant_id","expires_at") WHERE "feed_items"."status" = 'suggestion';--> statement-breakpoint
CREATE INDEX "feed_items_dismissed_idx" ON "feed_items" USING btree ("tenant_id","kind","subject_key","snoozed_until") WHERE "feed_items"."status" = 'dismissed';--> statement-breakpoint
CREATE INDEX "feed_items_audience_idx" ON "feed_items" USING btree ("tenant_id","audience_staff_id");--> statement-breakpoint
CREATE INDEX "feed_items_client_idx" ON "feed_items" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "feed_items_booking_idx" ON "feed_items" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE INDEX "feed_items_staff_member_idx" ON "feed_items" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "feed_items_service_idx" ON "feed_items" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "feed_items_action_proposal_idx" ON "feed_items" USING btree ("tenant_id","action_proposal_id");--> statement-breakpoint
CREATE INDEX "insight_runs_last_run_at_idx" ON "insight_runs" USING btree ("last_run_at");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_rebook_after_days_range" CHECK ("services"."rebook_after_days" BETWEEN 7 AND 365);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "feed_items" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "feed_items" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR audience_staff_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR audience_staff_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "member_scope_insert" ON "feed_items" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "member_scope_delete" ON "feed_items" AS RESTRICTIVE FOR DELETE TO public USING ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "insight_runs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "job_scan" ON "insight_runs" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('insights'));