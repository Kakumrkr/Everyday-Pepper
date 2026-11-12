CREATE TABLE "booking_manage_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"booking_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_manage_links_token_hash_format" CHECK ("booking_manage_links"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "booking_manage_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "booking_texts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_texts_kind_known" CHECK ("booking_texts"."kind" IN ('opt_in', 'confirmation', 'day_before', 'same_day'))
);
--> statement-breakpoint
ALTER TABLE "booking_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_reminders" ADD COLUMN "kind" text DEFAULT 'day_before' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_reminders" DROP CONSTRAINT "booking_reminders_pkey";--> statement-breakpoint
ALTER TABLE "booking_reminders" ADD CONSTRAINT "booking_reminders_pkey" PRIMARY KEY("id","kind");--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "client_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reminder_settings" jsonb DEFAULT '{"texts": true, "dayBefore": true, "sameDay": true, "sameDayLeadHours": 2}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_manage_links" ADD CONSTRAINT "booking_manage_links_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_texts" ADD CONSTRAINT "booking_texts_message_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."outbox_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_texts" ADD CONSTRAINT "booking_texts_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_texts" ADD CONSTRAINT "booking_texts_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_manage_links_token_hash_unique" ON "booking_manage_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "booking_manage_links_booking_idx" ON "booking_manage_links" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE INDEX "booking_texts_client_idx" ON "booking_texts" USING btree ("tenant_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_texts_booking_idx" ON "booking_texts" USING btree ("tenant_id","booking_id");--> statement-breakpoint
ALTER TABLE "booking_reminders" ADD CONSTRAINT "booking_reminders_kind_known" CHECK ("booking_reminders"."kind" IN ('day_before', 'same_day'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_manage_links" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_texts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- SMS reminders and confirm by text (S62, ADR-0065), beyond what drizzle-kit expresses. RLS
-- applies to the table owner too, as for every tenant-owned table (ADR-0010).
ALTER TABLE "booking_texts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_manage_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON "booking_texts", "booking_manage_links" FROM pepper_app;
--> statement-breakpoint
-- "C" to confirm (AC-X-74). A reply reaches Pepper's one number with no business to bind to,
-- so a definer function answers which booking it confirms (ids only, never a name, a time or a
-- client): the soonest upcoming confirmed booking whose reminder went, in the 48 hours before
-- `p_at`, to a client whose consent in force is for this number, at the start it was reminded
-- for; one the client hasn't confirmed yet first, so a "C" to a second reminder reaches it. A
-- business being deleted is left out (its texts stopped when deletion was asked).
CREATE POLICY "sms_confirm_lookup" ON "booking_texts" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY "sms_confirm_lookup" ON "bookings" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION sms_confirm_target(p_phone text, p_at timestamptz)
  RETURNS TABLE (tenant_id uuid, booking_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT b.tenant_id, b.id
      FROM booking_texts bt
      JOIN sms_consents c
        ON c.tenant_id = bt.tenant_id AND c.client_id = bt.client_id
       AND c.phone = p_phone AND c.revoked_at IS NULL
      JOIN bookings b ON b.tenant_id = bt.tenant_id AND b.id = bt.booking_id
      JOIN tenants t ON t.id = bt.tenant_id
     WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
       AND bt.kind IN ('day_before', 'same_day')
       AND bt.created_at > p_at - interval '48 hours'
       AND bt.created_at <= p_at
       AND b.status = 'confirmed'
       AND b.starts_at = bt.starts_at
       AND b.starts_at > p_at
       AND t.deletion_due_at IS NULL
     ORDER BY (b.client_confirmed_at IS NOT NULL) ASC, b.starts_at ASC, b.id ASC
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_confirm_target(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_confirm_target(text, timestamptz) TO pepper_app;
