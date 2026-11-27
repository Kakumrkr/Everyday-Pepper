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
-- days before `p_at` (`CLIENT_TEXT_WINDOW_DAYS`): a booking text, a waitlist offer by text or a
-- reply. None or more than one (two businesses, or two clients of one) answers nothing, so a
-- text is never stored where it may not belong. A business being deleted is left out.
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
    WITH sent AS (
      SELECT bt.tenant_id, bt.client_id
        FROM booking_texts bt
       WHERE bt.created_at > p_at - interval '7 days' AND bt.created_at <= p_at
      UNION
      SELECT o.tenant_id, o.client_id
        FROM waitlist_offers o
       WHERE o.texted_at > p_at - interval '7 days' AND o.texted_at <= p_at
      UNION
      SELECT ct.tenant_id, ct.client_id
        FROM client_texts ct
       WHERE ct.direction = 'out'
         AND ct.created_at > p_at - interval '7 days' AND ct.created_at <= p_at
    ),
    fit AS (
      SELECT DISTINCT s.tenant_id, s.client_id
        FROM sent s
        JOIN sms_consents c
          ON c.tenant_id = s.tenant_id AND c.client_id = s.client_id
         AND c.phone = p_phone AND c.revoked_at IS NULL
        JOIN tenants t ON t.id = s.tenant_id
       WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
         AND t.deletion_due_at IS NULL
    )
    SELECT fit.tenant_id, fit.client_id FROM fit WHERE (SELECT count(*) FROM fit) = 1
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_reply_target(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_reply_target(text, timestamptz) TO pepper_app;
