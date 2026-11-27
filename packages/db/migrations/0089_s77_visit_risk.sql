CREATE TABLE "visit_risks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"booking_id" uuid NOT NULL,
	"band" text NOT NULL,
	"points" smallint NOT NULL,
	"reasons" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "visit_risks_band_known" CHECK ("visit_risks"."band" IN ('low', 'medium', 'high')),
	CONSTRAINT "visit_risks_points_range" CHECK ("visit_risks"."points" BETWEEN 0 AND 20),
	CONSTRAINT "visit_risks_reasons_array" CHECK (jsonb_typeof("visit_risks"."reasons") = 'array' AND jsonb_array_length("visit_risks"."reasons") <= 8)
);
--> statement-breakpoint
ALTER TABLE "visit_risks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
-- S77 (ADR-0071): a cancelled visit's time of cancellation, for a late cancel. Older ones take
-- their audit entry's time (as the pilot metrics did, migration 0073), else `updated_at`.
UPDATE "bookings" AS b
SET "cancelled_at" = COALESCE(
  (SELECT min(l."created_at") FROM "audit_log" AS l
    WHERE l."tenant_id" = b."tenant_id" AND l."entity_type" = 'booking'
      AND l."entity_id" = b."id" AND l."action" = 'booking.updated'
      AND l."after" ->> 'status' = 'cancelled'),
  b."updated_at")
WHERE b."status" = 'cancelled';
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_at" CHECK (("bookings"."status" = 'cancelled') = ("bookings"."cancelled_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "visit_risks" ADD CONSTRAINT "visit_risks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_risks" ADD CONSTRAINT "visit_risks_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_risks_booking_unique" ON "visit_risks" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visit_risks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "visit_risks" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all())) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
-- Beyond what drizzle-kit expresses. RLS applies to the table owner too (ADR-0010).
ALTER TABLE "visit_risks" FORCE ROW LEVEL SECURITY;
