CREATE TABLE "booking_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_member_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"code_hash" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_verifications_name_length" CHECK (length("booking_verifications"."name") BETWEEN 1 AND 120),
	CONSTRAINT "booking_verifications_email_format" CHECK ("booking_verifications"."email" = lower("booking_verifications"."email") AND length("booking_verifications"."email") BETWEEN 3 AND 254 AND "booking_verifications"."email" LIKE '%_@_%'),
	CONSTRAINT "booking_verifications_phone_format" CHECK ("booking_verifications"."phone" ~ '^[+][1-9][0-9]{6,14}$'),
	CONSTRAINT "booking_verifications_code_hash_format" CHECK ("booking_verifications"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "booking_verifications_attempts_range" CHECK ("booking_verifications"."attempts" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "booking_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "manage_token_hash" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_verifications_email_idx" ON "booking_verifications" USING btree ("tenant_id","email","expires_at");--> statement-breakpoint
CREATE INDEX "booking_verifications_service_idx" ON "booking_verifications" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "booking_verifications_staff_member_idx" ON "booking_verifications" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "booking_verifications_booking_idx" ON "booking_verifications" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_manage_token_hash_unique" ON "bookings" USING btree ("manage_token_hash");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_manage_token_hash_format" CHECK ("bookings"."manage_token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_brand_color_format" CHECK ("tenants"."brand_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
CREATE POLICY "public_lookup" ON "tenants" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND slug = current_public_slug());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_verifications" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "booking_verifications" AS RESTRICTIVE FOR ALL TO public USING (current_user_id() IS NULL) WITH CHECK (current_user_id() IS NULL);