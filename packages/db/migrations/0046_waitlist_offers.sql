ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE TABLE "waitlist_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"booking_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_matches_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "waitlist_matches_status_known" CHECK ("waitlist_matches"."status" IN ('pending', 'done')),
	CONSTRAINT "waitlist_matches_outcome_known" CHECK ("waitlist_matches"."outcome" IS NULL OR "waitlist_matches"."outcome" IN ('offered', 'proposed', 'no_match', 'too_soon', 'failed')),
	CONSTRAINT "waitlist_matches_done_has_outcome" CHECK (("waitlist_matches"."status" = 'done') = ("waitlist_matches"."outcome" IS NOT NULL)),
	CONSTRAINT "waitlist_matches_slot_order" CHECK ("waitlist_matches"."ends_at" > "waitlist_matches"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "waitlist_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waitlist_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"match_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"rank" smallint NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_offers_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "waitlist_offers_match_entry_unique" UNIQUE("tenant_id","match_id","entry_id"),
	CONSTRAINT "waitlist_offers_status_known" CHECK ("waitlist_offers"."status" IN ('offered', 'claimed', 'taken', 'expired')),
	CONSTRAINT "waitlist_offers_claimed_has_booking" CHECK (("waitlist_offers"."status" = 'claimed') = ("waitlist_offers"."booking_id" IS NOT NULL)),
	CONSTRAINT "waitlist_offers_rank_range" CHECK ("waitlist_offers"."rank" BETWEEN 1 AND 5),
	CONSTRAINT "waitlist_offers_token_hash_format" CHECK ("waitlist_offers"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "waitlist_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waitlist_matches" ADD CONSTRAINT "waitlist_matches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_matches" ADD CONSTRAINT "waitlist_matches_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_matches" ADD CONSTRAINT "waitlist_matches_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_match_fk" FOREIGN KEY ("tenant_id","match_id") REFERENCES "public"."waitlist_matches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."waitlist_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_staff_member_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlist_matches_due_idx" ON "waitlist_matches" USING btree ("available_at") WHERE "waitlist_matches"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "waitlist_matches_booking_idx" ON "waitlist_matches" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE INDEX "waitlist_matches_staff_member_idx" ON "waitlist_matches" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "waitlist_offers_open_idx" ON "waitlist_offers" USING btree ("expires_at") WHERE "waitlist_offers"."status" = 'offered';--> statement-breakpoint
CREATE INDEX "waitlist_offers_entry_idx" ON "waitlist_offers" USING btree ("tenant_id","entry_id");--> statement-breakpoint
CREATE INDEX "waitlist_offers_client_idx" ON "waitlist_offers" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "waitlist_offers_service_idx" ON "waitlist_offers" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "waitlist_offers_staff_member_idx" ON "waitlist_offers" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "waitlist_offers_booking_idx" ON "waitlist_offers" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_matches" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "waitlist_matches" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "job_scan" ON "waitlist_matches" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('waitlist'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_offers" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "waitlist_offers" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids())) WITH CHECK ((SELECT current_member_sees_all()) OR staff_member_id IN (SELECT current_member_staff_ids()));--> statement-breakpoint
CREATE POLICY "member_scope_insert" ON "waitlist_offers" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ((SELECT current_member_sees_all()));