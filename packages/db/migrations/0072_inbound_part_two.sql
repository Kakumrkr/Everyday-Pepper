CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resumed_at" timestamp with time zone,
	"resumed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_event_unique" UNIQUE("provider","event_id"),
	CONSTRAINT "email_suppressions_provider_known" CHECK ("email_suppressions"."provider" IN ('resend')),
	CONSTRAINT "email_suppressions_kind_known" CHECK ("email_suppressions"."kind" IN ('hard_bounce', 'soft_bounce', 'complaint')),
	CONSTRAINT "email_suppressions_address_format" CHECK (length("email_suppressions"."address") BETWEEN 3 AND 254 AND "email_suppressions"."address" = lower("email_suppressions"."address") AND position('@' in "email_suppressions"."address") > 1),
	CONSTRAINT "email_suppressions_event_length" CHECK (length("email_suppressions"."event_id") BETWEEN 1 AND 200),
	CONSTRAINT "email_suppressions_resumed" CHECK (("email_suppressions"."resumed_at" IS NULL) = ("email_suppressions"."resumed_by" IS NULL) AND ("email_suppressions"."resumed_at" IS NULL OR "email_suppressions"."kind" <> 'soft_bounce'))
);
--> statement-breakpoint
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_emails" DROP CONSTRAINT "inbound_emails_landed";--> statement-breakpoint
ALTER TABLE "inbound_emails" DROP CONSTRAINT "inbound_emails_held_content";--> statement-breakpoint
ALTER TABLE "inbound_emails" DROP CONSTRAINT "inbound_emails_held_size";--> statement-breakpoint
ALTER TABLE "operator_access_log" DROP CONSTRAINT "operator_access_log_action_known";--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "held_subject" text;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "public_request_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "support_note_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "sender_hash" text;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD COLUMN "channel" text DEFAULT 'form' NOT NULL;--> statement-breakpoint
CREATE INDEX "email_suppressions_address_idx" ON "email_suppressions" USING btree ("address","occurred_at");--> statement-breakpoint
CREATE INDEX "email_suppressions_created_idx" ON "email_suppressions" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_public_request_id_public_support_requests_id_fk" FOREIGN KEY ("public_request_id") REFERENCES "public"."public_support_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_support_note_id_support_notes_id_fk" FOREIGN KEY ("support_note_id") REFERENCES "public"."support_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_emails_sender_idx" ON "inbound_emails" USING btree ("sender_hash","processed_at");--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_sender_hash" CHECK ("inbound_emails"."sender_hash" IS NULL OR "inbound_emails"."sender_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_accepted" CHECK (("inbound_emails"."accepted_by" IS NULL) = ("inbound_emails"."accepted_at" IS NULL));--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_landed" CHECK ("inbound_emails"."status" <> 'landed' OR ("inbound_emails"."tenant_id" IS NOT NULL AND "inbound_emails"."thread_id" IS NOT NULL AND (("inbound_emails"."support_message_id" IS NULL) <> ("inbound_emails"."support_note_id" IS NULL)) AND "inbound_emails"."public_request_id" IS NULL) OR ("inbound_emails"."public_request_id" IS NOT NULL AND "inbound_emails"."tenant_id" IS NULL AND "inbound_emails"."thread_id" IS NULL));--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_held_content" CHECK (("inbound_emails"."from_address" IS NULL AND "inbound_emails"."held_text" IS NULL AND "inbound_emails"."held_subject" IS NULL) OR "inbound_emails"."status" = 'held');--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_held_size" CHECK (("inbound_emails"."from_address" IS NULL OR length("inbound_emails"."from_address") <= 254) AND ("inbound_emails"."held_text" IS NULL OR length("inbound_emails"."held_text") <= 4000) AND ("inbound_emails"."held_subject" IS NULL OR length("inbound_emails"."held_subject") <= 200));--> statement-breakpoint
ALTER TABLE "operator_access_log" ADD CONSTRAINT "operator_access_log_action_known" CHECK ("operator_access_log"."action" IN ('inbox.read', 'thread.read', 'thread.reply', 'thread.note', 'thread.status', 'public.read', 'public.note', 'public.status', 'replies.read', 'replies.write', 'screenshot.read', 'held.read', 'held.accept', 'held.discard', 'mail.resume', 'inbound.counts'));--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD CONSTRAINT "public_support_requests_channel_known" CHECK ("public_support_requests"."channel" IN ('form', 'email'));--> statement-breakpoint
CREATE POLICY "operator_access" ON "inbound_emails" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "operator_review" ON "inbound_emails" AS PERMISSIVE FOR UPDATE TO public USING ((SELECT current_operator_id()) IS NOT NULL AND status = 'held') WITH CHECK ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "inbound_mail" ON "email_suppressions" AS PERMISSIVE FOR ALL TO public USING (COALESCE(current_setting('app.inbound_mail', true) = 'on', false)) WITH CHECK (COALESCE(current_setting('app.inbound_mail', true) = 'on', false));--> statement-breakpoint
CREATE POLICY "operator_access" ON "email_suppressions" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "operator_resume" ON "email_suppressions" AS PERMISSIVE FOR UPDATE TO public USING ((SELECT current_operator_id()) IS NOT NULL) WITH CHECK ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
-- Email, part 2 (S59.3.2, ADR-0063 Part 2), beyond what drizzle-kit expresses. Delivery problems
-- are platform rows like inbound mail: RLS applies to the table owner too, and the services keep
-- them (an operator resumes an address, nothing deletes one).
ALTER TABLE "email_suppressions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "email_suppressions" FROM pepper_app;
--> statement-breakpoint
-- Whether support email to an address is stopped: its latest hard bounce or complaint not yet
-- resumed. Asked at delivery, in any transaction, so a definer function (a boolean, nothing else).
CREATE POLICY "suppression_lookup" ON "email_suppressions" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION support_mail_stopped(p_address text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM email_suppressions s
       WHERE s.address = lower(p_address)
         AND s.kind IN ('hard_bounce', 'complaint')
         AND s.resumed_at IS NULL
    )
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION support_mail_stopped(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_mail_stopped(text) TO pepper_app;
--> statement-breakpoint
-- The member an email to the team's address came from, once the receiver's check passed (core
-- does that first): the user, the business it goes to and how many they belong to; ids only.
-- The business is the one their latest session chose (still a membership), else the first
-- they joined. A definer function: there is no business to bind to yet.
CREATE POLICY "inbound_member_lookup" ON "memberships" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION support_inbound_member(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, businesses integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, m.tenant_id, (count(*) OVER ())::integer
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT s.active_tenant_id
          FROM sessions s
         WHERE s.user_id = u.id AND s.active_tenant_id IS NOT NULL
         ORDER BY s.updated_at DESC, s.id
         LIMIT 1
      ) latest ON true
     WHERE length(p_email) BETWEEN 3 AND 254
       AND u.email = lower(p_email)
       AND u.email_verified
       AND u.deletion_due_at IS NULL
     ORDER BY (m.tenant_id = latest.active_tenant_id) IS TRUE DESC, m.created_at, m.tenant_id
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION support_inbound_member(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_inbound_member(text) TO pepper_app;
