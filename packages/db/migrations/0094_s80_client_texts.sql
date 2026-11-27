CREATE TABLE "client_texts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"provider" text,
	"provider_event_id" text,
	"outbox_message_id" uuid,
	"sent_by_user_id" uuid,
	"feed_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_texts_provider_event_unique" UNIQUE("tenant_id","provider","provider_event_id"),
	CONSTRAINT "client_texts_direction_known" CHECK ("client_texts"."direction" IN ('in', 'out')),
	CONSTRAINT "client_texts_body_length" CHECK (length("client_texts"."body") BETWEEN 1 AND 1600),
	CONSTRAINT "client_texts_in_has_event" CHECK (("client_texts"."direction" = 'in') = ("client_texts"."provider_event_id" IS NOT NULL AND "client_texts"."provider" IS NOT NULL)),
	CONSTRAINT "client_texts_out_has_message" CHECK (("client_texts"."direction" = 'out') = ("client_texts"."outbox_message_id" IS NOT NULL AND "client_texts"."sent_by_user_id" IS NOT NULL)),
	CONSTRAINT "client_texts_provider_known" CHECK ("client_texts"."provider" IS NULL OR "client_texts"."provider" IN ('twilio', 'sandbox')),
	CONSTRAINT "client_texts_provider_event_format" CHECK ("client_texts"."provider_event_id" IS NULL OR "client_texts"."provider_event_id" ~ '^[A-Za-z0-9:_-]{1,100}$')
);
--> statement-breakpoint
ALTER TABLE "client_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_kind_known";--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "texted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD COLUMN "texted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_texts" ADD CONSTRAINT "client_texts_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_texts_client_idx" ON "client_texts" USING btree ("tenant_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "client_texts_created_idx" ON "client_texts" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_kind_known" CHECK ("feed_items"."kind" IN ('schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload', 'waitlist_match', 'daily_briefing', 'calendar_kept', 'client_text'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_texts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Client texts kept (S80, ADR-0072), beyond what drizzle-kit expresses. RLS applies to the table
-- owner too, as for every tenant-owned table (ADR-0010).
ALTER TABLE "client_texts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON "client_texts" FROM pepper_app;
--> statement-breakpoint
-- A client's text reaches Pepper's one number with no business to bind to, so a definer function
-- answers whose it is (ids only, never a name, a time or the words): the one business, and the
-- one client of it whose consent in force is for this number, that texted the number in the 7
-- days before `p_at` (`CLIENT_TEXT_WINDOW_DAYS`): a booking text, a waitlist opt-in or offer by
-- text, or a reply. None or more than one (two businesses, or two clients of one) answers
-- nothing, so a text is never stored where it may not belong. A business being deleted is left
-- out. It starts from the number's consents (indexed by phone), then looks for a text per client.
CREATE POLICY "sms_reply_lookup" ON "waitlist_entries" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY "sms_reply_lookup" ON "waitlist_offers" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY "sms_reply_lookup" ON "client_texts" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION sms_reply_target(p_phone text, p_at timestamptz)
  RETURNS TABLE (tenant_id uuid, client_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH fit AS (
      SELECT DISTINCT c.tenant_id, c.client_id
        FROM sms_consents c
        JOIN tenants t ON t.id = c.tenant_id
       WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
         AND c.phone = p_phone
         AND c.revoked_at IS NULL
         AND c.client_id IS NOT NULL
         AND t.deletion_due_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM booking_texts bt
              WHERE bt.tenant_id = c.tenant_id AND bt.client_id = c.client_id
                AND bt.created_at > p_at - interval '7 days' AND bt.created_at <= p_at)
           OR EXISTS (
             SELECT 1 FROM waitlist_entries e
              WHERE e.tenant_id = c.tenant_id AND e.client_id = c.client_id
                AND e.texted_at > p_at - interval '7 days' AND e.texted_at <= p_at)
           OR EXISTS (
             SELECT 1 FROM waitlist_offers o
              WHERE o.tenant_id = c.tenant_id AND o.client_id = c.client_id
                AND o.texted_at > p_at - interval '7 days' AND o.texted_at <= p_at)
           OR EXISTS (
             SELECT 1 FROM client_texts ct
              WHERE ct.tenant_id = c.tenant_id AND ct.client_id = c.client_id
                AND ct.direction = 'out'
                AND ct.created_at > p_at - interval '7 days' AND ct.created_at <= p_at)
         )
    )
    SELECT fit.tenant_id, fit.client_id FROM fit WHERE (SELECT count(*) FROM fit) = 1
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_reply_target(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_reply_target(text, timestamptz) TO pepper_app;
