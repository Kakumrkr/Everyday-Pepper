CREATE TABLE "inbound_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"provider_email_id" text NOT NULL,
	"message_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"tenant_id" uuid,
	"thread_id" uuid,
	"support_message_id" uuid,
	"from_address" text,
	"held_text" text,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_emails_event_unique" UNIQUE("provider","event_id"),
	CONSTRAINT "inbound_emails_provider_email_unique" UNIQUE("provider","provider_email_id"),
	CONSTRAINT "inbound_emails_provider_known" CHECK ("inbound_emails"."provider" IN ('resend')),
	CONSTRAINT "inbound_emails_status_known" CHECK ("inbound_emails"."status" IN ('received', 'landed', 'held', 'ignored', 'refused', 'failed')),
	CONSTRAINT "inbound_emails_ids_length" CHECK (length("inbound_emails"."event_id") BETWEEN 1 AND 200 AND length("inbound_emails"."provider_email_id") BETWEEN 1 AND 200 AND ("inbound_emails"."message_id" IS NULL OR length("inbound_emails"."message_id") BETWEEN 3 AND 300)),
	CONSTRAINT "inbound_emails_reason_length" CHECK ("inbound_emails"."reason" IS NULL OR "inbound_emails"."reason" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "inbound_emails_landed" CHECK ("inbound_emails"."status" <> 'landed' OR ("inbound_emails"."tenant_id" IS NOT NULL AND "inbound_emails"."thread_id" IS NOT NULL AND "inbound_emails"."support_message_id" IS NOT NULL)),
	CONSTRAINT "inbound_emails_held_content" CHECK (("inbound_emails"."from_address" IS NULL AND "inbound_emails"."held_text" IS NULL) OR ("inbound_emails"."status" = 'held' AND "inbound_emails"."tenant_id" IS NOT NULL)),
	CONSTRAINT "inbound_emails_held_size" CHECK (("inbound_emails"."from_address" IS NULL OR length("inbound_emails"."from_address") <= 254) AND ("inbound_emails"."held_text" IS NULL OR length("inbound_emails"."held_text") <= 4000))
);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "channel" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."support_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_emails_message_id_unique" ON "inbound_emails" USING btree ("message_id") WHERE "inbound_emails"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inbound_emails_due_idx" ON "inbound_emails" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_emails_thread_idx" ON "inbound_emails" USING btree ("tenant_id","thread_id","processed_at");--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_channel" CHECK ("support_messages"."channel" = 'app' OR ("support_messages"."channel" = 'email' AND "support_messages"."author_kind" = 'member'));--> statement-breakpoint
CREATE POLICY "inbound_mail" ON "inbound_emails" AS PERMISSIVE FOR ALL TO public USING (COALESCE(current_setting('app.inbound_mail', true) = 'on', false)) WITH CHECK (COALESCE(current_setting('app.inbound_mail', true) = 'on', false));--> statement-breakpoint
-- Replies by email (S59.3, ADR-0063), beyond what drizzle-kit expresses. Inbound rows are
-- platform rows: RLS applies to the table owner too, and the services keep them (contents are
-- emptied, rows stay for the counts); they go only with their business or thread.
ALTER TABLE "inbound_emails" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "inbound_emails" FROM pepper_app;
--> statement-breakpoint
-- The request an emailed reply names, found by its reference once its signature has checked
-- (core does that first): the business and the thread's id, nothing else. A definer function,
-- as there is no business to bind to yet; the owner reads threads only through this policy.
CREATE POLICY "inbound_lookup" ON "support_threads" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION support_inbound_thread(p_reference text)
  RETURNS TABLE (tenant_id uuid, thread_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.tenant_id, t.id
      FROM support_threads t
     WHERE p_reference ~ '^PEP-[0-9A-HJKMNP-TV-Z]{6}$'
       AND t.reference = p_reference
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION support_inbound_thread(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_inbound_thread(text) TO pepper_app;
