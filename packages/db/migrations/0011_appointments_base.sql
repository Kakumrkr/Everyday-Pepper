CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"duration_minutes" integer NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"price_from_cents" integer,
	"price_to_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_name_length" CHECK (length("services"."name") BETWEEN 1 AND 120),
	CONSTRAINT "services_category_length" CHECK (length("services"."category") BETWEEN 1 AND 60),
	CONSTRAINT "services_duration_range" CHECK ("services"."duration_minutes" BETWEEN 5 AND 720),
	CONSTRAINT "services_buffers_range" CHECK ("services"."buffer_before_minutes" BETWEEN 0 AND 240 AND "services"."buffer_after_minutes" BETWEEN 0 AND 240),
	CONSTRAINT "services_price_range" CHECK ("services"."price_from_cents" BETWEEN 0 AND 10000000 AND "services"."price_to_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "services_price_to_after_from" CHECK ("services"."price_to_cents" IS NULL OR ("services"."price_from_cents" IS NOT NULL AND "services"."price_to_cents" > "services"."price_from_cents"))
);
--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"display_name" text NOT NULL,
	"color" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_members_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_members_membership_id_unique" UNIQUE("membership_id"),
	CONSTRAINT "staff_members_display_name_length" CHECK (length("staff_members"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "staff_members_color_format" CHECK ("staff_members"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "staff_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_services_staff_service_unique" UNIQUE("staff_member_id","service_id")
);
--> statement-breakpoint
ALTER TABLE "staff_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_ends_after_start" CHECK ("time_off"."ends_at" > "time_off"."starts_at"),
	CONSTRAINT "time_off_max_length" CHECK ("time_off"."ends_at" - "time_off"."starts_at" <= interval '366 days')
);
--> statement-breakpoint
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "working_hours" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_minute" smallint NOT NULL,
	"end_minute" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_hours_weekday_range" CHECK ("working_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "working_hours_minutes_range" CHECK ("working_hours"."start_minute" >= 0 AND "working_hours"."end_minute" <= 1440 AND "working_hours"."end_minute" > "working_hours"."start_minute")
);
--> statement-breakpoint
ALTER TABLE "working_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_name_unique" ON "services" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "staff_services_tenant_service_idx" ON "staff_services" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "time_off_staff_member_ends_at_idx" ON "time_off" USING btree ("tenant_id","staff_member_id","ends_at");--> statement-breakpoint
CREATE INDEX "time_off_created_by_user_id_idx" ON "time_off" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "services" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_members" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_services" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "time_off" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "working_hours" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());