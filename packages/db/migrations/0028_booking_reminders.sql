CREATE TABLE "booking_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	CONSTRAINT "booking_reminders_due_before_start" CHECK ("booking_reminders"."due_at" < "booking_reminders"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "booking_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_reminders" ADD CONSTRAINT "booking_reminders_booking_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_reminders_due_at_idx" ON "booking_reminders" USING btree ("due_at");--> statement-breakpoint
CREATE POLICY "job_scan" ON "tenants" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('cleanup'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_reminders" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "job_scan" ON "booking_reminders" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('reminders'));