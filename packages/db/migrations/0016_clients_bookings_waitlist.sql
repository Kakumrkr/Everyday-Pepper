CREATE TABLE "booking_occupancy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"occupied" "tstzrange" NOT NULL,
	CONSTRAINT "booking_occupancy_covers_booking" CHECK (lower("booking_occupancy"."occupied") <= "booking_occupancy"."starts_at" AND "booking_occupancy"."ends_at" <= upper("booking_occupancy"."occupied") AND "booking_occupancy"."ends_at" > "booking_occupancy"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "booking_occupancy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_before_minutes" integer NOT NULL,
	"buffer_after_minutes" integer NOT NULL,
	"price_from_cents" integer,
	"price_to_cents" integer,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source" text NOT NULL,
	"overridden" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "bookings_duration_range" CHECK ("bookings"."ends_at" - "bookings"."starts_at" BETWEEN interval '5 minutes' AND interval '720 minutes'),
	CONSTRAINT "bookings_buffers_range" CHECK ("bookings"."buffer_before_minutes" BETWEEN 0 AND 240 AND "bookings"."buffer_after_minutes" BETWEEN 0 AND 240),
	CONSTRAINT "bookings_price_range" CHECK ("bookings"."price_from_cents" BETWEEN 0 AND 10000000 AND "bookings"."price_to_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "bookings_status_known" CHECK ("bookings"."status" IN ('confirmed', 'completed', 'no_show', 'cancelled')),
	CONSTRAINT "bookings_source_known" CHECK ("bookings"."source" IN ('team', 'ai', 'booking_page')),
	CONSTRAINT "bookings_idempotency_key_format" CHECK ("bookings"."idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$')
);
--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "clients_name_length" CHECK (length("clients"."name") BETWEEN 1 AND 120),
	CONSTRAINT "clients_email_format" CHECK ("clients"."email" = lower("clients"."email") AND length("clients"."email") BETWEEN 3 AND 254 AND "clients"."email" LIKE '%_@_%'),
	CONSTRAINT "clients_phone_format" CHECK ("clients"."phone" ~ '^[+][1-9][0-9]{6,14}$'),
	CONSTRAINT "clients_source_known" CHECK ("clients"."source" IN ('team', 'ai', 'booking_page', 'import'))
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_member_id" uuid,
	"windows" jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"booking_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_status_known" CHECK ("waitlist_entries"."status" IN ('waiting', 'offered', 'booked', 'cancelled')),
	CONSTRAINT "waitlist_entries_booked_has_booking" CHECK (("waitlist_entries"."status" = 'booked') = ("waitlist_entries"."booking_id" IS NOT NULL)),
	CONSTRAINT "waitlist_entries_windows_array" CHECK (jsonb_typeof("waitlist_entries"."windows") = 'array' AND jsonb_array_length("waitlist_entries"."windows") BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_occupancy" ADD CONSTRAINT "booking_occupancy_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_occupancy" ADD CONSTRAINT "booking_occupancy_booking_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_occupancy" ADD CONSTRAINT "booking_occupancy_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_tenant_idempotency_key_unique" ON "bookings" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bookings_staff_member_starts_at_idx" ON "bookings" USING btree ("tenant_id","staff_member_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_tenant_starts_at_idx" ON "bookings" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_client_idx" ON "bookings" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "bookings_service_idx" ON "bookings" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "bookings_created_by_user_id_idx" ON "bookings" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_email_unique" ON "clients" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "clients_tenant_name_idx" ON "clients" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "waitlist_entries_open_idx" ON "waitlist_entries" USING btree ("tenant_id","created_at") WHERE "waitlist_entries"."status" IN ('waiting', 'offered');--> statement-breakpoint
CREATE INDEX "waitlist_entries_client_idx" ON "waitlist_entries" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_service_idx" ON "waitlist_entries" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_staff_member_idx" ON "waitlist_entries" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_booking_idx" ON "waitlist_entries" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_created_by_user_id_idx" ON "waitlist_entries" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_occupancy" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope_insert" ON "booking_occupancy" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "member_scope_update" ON "booking_occupancy" AS RESTRICTIVE FOR UPDATE TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "member_scope_delete" ON "booking_occupancy" AS RESTRICTIVE FOR DELETE TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bookings" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "bookings" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "clients" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR id IN (SELECT client_id FROM bookings) OR id IN (SELECT client_id FROM waitlist_entries)) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "member_scope_delete" ON "clients" AS RESTRICTIVE FOR DELETE TO public USING ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_entries" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "waitlist_entries" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));