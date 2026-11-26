-- Recurring appointments (S72, ADR-0070): a series of ordinary bookings. `booking_series` keeps
-- what was asked (the staff member, every how many weeks, the start times) and the series'
-- idempotency key; each visit is a booking with `series_id`.
CREATE TABLE "booking_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"every_weeks" integer NOT NULL,
	"requested_starts" timestamp with time zone[] NOT NULL,
	"idempotency_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_series_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_series_every_weeks_range" CHECK ("booking_series"."every_weeks" BETWEEN 1 AND 4),
	CONSTRAINT "booking_series_requested_starts_count" CHECK (cardinality("booking_series"."requested_starts") BETWEEN 2 AND 26),
	CONSTRAINT "booking_series_idempotency_key_format" CHECK ("booking_series"."idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$')
);
--> statement-breakpoint
ALTER TABLE "booking_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_series_tenant_idempotency_key_unique" ON "booking_series" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "booking_series_staff_member_idx" ON "booking_series" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "booking_series_created_by_user_id_idx" ON "booking_series" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_series_fk" FOREIGN KEY ("tenant_id","series_id") REFERENCES "public"."booking_series"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_series_idx" ON "bookings" USING btree ("tenant_id","series_id","starts_at") WHERE "bookings"."series_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_series" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "booking_series" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
-- Beyond what drizzle-kit expresses. RLS applies to the table owner too (ADR-0010).
ALTER TABLE "booking_series" FORCE ROW LEVEL SECURITY;
