CREATE TABLE "booking_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid,
	"type" text NOT NULL,
	"version" smallint NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_rules_type_known" CHECK ("booking_rules"."type" IN ('slot_interval', 'minimum_notice', 'maximum_advance', 'max_bookings_per_day', 'blackout_window')),
	CONSTRAINT "booking_rules_version_positive" CHECK ("booking_rules"."version" >= 1),
	CONSTRAINT "booking_rules_params_object" CHECK (jsonb_typeof("booking_rules"."params") = 'object')
);
--> statement-breakpoint
ALTER TABLE "booking_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD CONSTRAINT "booking_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD CONSTRAINT "booking_rules_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_rules_staff_member_idx" ON "booking_rules" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_rules" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());