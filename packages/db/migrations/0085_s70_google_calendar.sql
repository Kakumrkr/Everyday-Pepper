-- Google Calendar in (S70, ADR-0069): a staff member's connection (sealed tokens), the one-time
-- connect states, and the busy times read from it (start and end only).
CREATE TABLE "calendar_busy_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"connection_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calendar_busy_blocks_ends_after_start" CHECK ("calendar_busy_blocks"."ends_at" > "calendar_busy_blocks"."starts_at"),
	CONSTRAINT "calendar_busy_blocks_max_length" CHECK ("calendar_busy_blocks"."ends_at" - "calendar_busy_blocks"."starts_at" <= interval '62 days')
);
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_connect_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"verifier_sealed" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connect_states_hash_length" CHECK (octet_length("calendar_connect_states"."state_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "calendar_connect_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"refresh_token_sealed" "bytea" NOT NULL,
	"access_token_sealed" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_connections_provider_known" CHECK ("calendar_connections"."provider" IN ('google', 'sandbox')),
	CONSTRAINT "calendar_connections_status_known" CHECK ("calendar_connections"."status" IN ('connected', 'needs_reconnect')),
	CONSTRAINT "calendar_connections_email_length" CHECK (char_length("calendar_connections"."account_email") BETWEEN 3 AND 320),
	CONSTRAINT "calendar_connections_error_format" CHECK ("calendar_connections"."last_error" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "calendar_connections_access_token_pair" CHECK (("calendar_connections"."access_token_sealed" IS NULL) = ("calendar_connections"."access_token_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."calendar_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connect_states" ADD CONSTRAINT "calendar_connect_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connect_states" ADD CONSTRAINT "calendar_connect_states_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connect_states" ADD CONSTRAINT "calendar_connect_states_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_busy_blocks_staff_ends_at_idx" ON "calendar_busy_blocks" USING btree ("tenant_id","staff_member_id","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_busy_blocks_connection_idx" ON "calendar_busy_blocks" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connect_states_staff_unique" ON "calendar_connect_states" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connect_states_hash_unique" ON "calendar_connect_states" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_staff_unique" ON "calendar_connections" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "calendar_connections_membership_idx" ON "calendar_connections" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "calendar_connections_due_idx" ON "calendar_connections" USING btree ("status","attempted_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_busy_blocks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_connect_states" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_connections" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "job_scan" ON "calendar_connections" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('calendar'));--> statement-breakpoint
-- Beyond what drizzle-kit expresses. RLS applies to the table owner too (ADR-0010).
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_connect_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "calendar_connections_set_updated_at" BEFORE UPDATE ON "calendar_connections"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
