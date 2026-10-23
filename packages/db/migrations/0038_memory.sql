CREATE TABLE "memory_episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"summary" text NOT NULL,
	"client_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_episodes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "memory_episodes_summary_length" CHECK (length("memory_episodes"."summary") BETWEEN 1 AND 1000),
	CONSTRAINT "memory_episodes_client_count" CHECK (cardinality("memory_episodes"."client_ids") <= 20),
	CONSTRAINT "memory_episodes_embedding_model_format" CHECK ("memory_episodes"."embedding_model" ~ '^[a-z0-9][a-z0-9._-]{0,79}$')
);
--> statement-breakpoint
ALTER TABLE "memory_episodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"subject_type" text NOT NULL,
	"client_id" uuid,
	"staff_member_id" uuid,
	"service_id" uuid,
	"booking_id" uuid,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"previous_value" text,
	"previous_until" timestamp with time zone,
	"sensitive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"source_turn_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_facts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "memory_facts_subject_type_known" CHECK ("memory_facts"."subject_type" IN ('business', 'client', 'staff', 'service', 'booking')),
	CONSTRAINT "memory_facts_subject_shape" CHECK (num_nonnulls("memory_facts"."client_id", "memory_facts"."staff_member_id", "memory_facts"."service_id", "memory_facts"."booking_id") = (CASE WHEN "memory_facts"."subject_type" = 'business' THEN 0 ELSE 1 END) AND ("memory_facts"."subject_type" <> 'client' OR "memory_facts"."client_id" IS NOT NULL) AND ("memory_facts"."subject_type" <> 'staff' OR "memory_facts"."staff_member_id" IS NOT NULL) AND ("memory_facts"."subject_type" <> 'service' OR "memory_facts"."service_id" IS NOT NULL) AND ("memory_facts"."subject_type" <> 'booking' OR "memory_facts"."booking_id" IS NOT NULL)),
	CONSTRAINT "memory_facts_key_format" CHECK ("memory_facts"."key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "memory_facts_value_length" CHECK (length("memory_facts"."value") BETWEEN 1 AND 500),
	CONSTRAINT "memory_facts_previous_value" CHECK (("memory_facts"."previous_value" IS NULL) = ("memory_facts"."previous_until" IS NULL) AND length("memory_facts"."previous_value") BETWEEN 1 AND 500),
	CONSTRAINT "memory_facts_status_known" CHECK ("memory_facts"."status" IN ('active', 'proposed')),
	CONSTRAINT "memory_facts_source_known" CHECK ("memory_facts"."source" IN ('screen', 'chat', 'ai_action'))
);
--> statement-breakpoint
ALTER TABLE "memory_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "memory_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD CONSTRAINT "memory_episodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD CONSTRAINT "memory_episodes_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_episodes_member_idx" ON "memory_episodes" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_episodes_created_at_idx" ON "memory_episodes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_episodes_client_ids_idx" ON "memory_episodes" USING gin ("client_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_facts_one_active" ON "memory_facts" USING btree ("tenant_id","subject_type",coalesce("client_id", "staff_member_id", "service_id", "booking_id", "tenant_id"),"key") WHERE "memory_facts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memory_facts_client_idx" ON "memory_facts" USING btree ("tenant_id","client_id") WHERE "memory_facts"."client_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_staff_member_idx" ON "memory_facts" USING btree ("tenant_id","staff_member_id") WHERE "memory_facts"."staff_member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_service_idx" ON "memory_facts" USING btree ("tenant_id","service_id") WHERE "memory_facts"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_booking_idx" ON "memory_facts" USING btree ("tenant_id","booking_id") WHERE "memory_facts"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_previous_until_idx" ON "memory_facts" USING btree ("tenant_id","previous_until") WHERE "memory_facts"."previous_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_facts_created_by_user_id_idx" ON "memory_facts" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_episodes" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "memory_episodes" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL OR user_id = current_user_id()) WITH CHECK (current_user_id() IS NULL OR user_id = current_user_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_facts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope_read" ON "memory_facts" AS RESTRICTIVE FOR SELECT TO public USING ((SELECT current_member_sees_all()) OR ((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids()))) OR (subject_type IN ('business', 'staff', 'service') AND NOT sensitive));--> statement-breakpoint
CREATE POLICY "member_scope_insert" ON "memory_facts" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ((SELECT current_member_sees_all()) OR ((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids()))));--> statement-breakpoint
CREATE POLICY "member_scope_update" ON "memory_facts" AS RESTRICTIVE FOR UPDATE TO public USING ((SELECT current_member_sees_all()) OR ((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids())))) WITH CHECK ((SELECT current_member_sees_all()) OR ((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids()))));--> statement-breakpoint
CREATE POLICY "member_scope_delete" ON "memory_facts" AS RESTRICTIVE FOR DELETE TO public USING ((SELECT current_member_sees_all()) OR ((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids()))));