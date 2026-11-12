ALTER TYPE "public"."outbox_message_type" ADD VALUE 'sms';--> statement-breakpoint
ALTER TYPE "public"."usage_metric" ADD VALUE 'sms_segments';--> statement-breakpoint
CREATE TABLE "sms_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"phone" text NOT NULL,
	"source" text NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"wording_version" text NOT NULL,
	"shown_text" text NOT NULL,
	"given_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_consents_phone_format" CHECK ("sms_consents"."phone" ~ '^[+]1[2-9][0-9]{9}$'),
	CONSTRAINT "sms_consents_source_subject" CHECK (("sms_consents"."source" = 'booking_page' AND "sms_consents"."client_id" IS NOT NULL AND "sms_consents"."user_id" IS NULL) OR ("sms_consents"."source" = 'member_settings' AND "sms_consents"."user_id" IS NOT NULL AND "sms_consents"."client_id" IS NULL)),
	CONSTRAINT "sms_consents_wording_format" CHECK ("sms_consents"."wording_version" ~ '^sms-consent-v[0-9]{1,3}$'),
	CONSTRAINT "sms_consents_shown_text_length" CHECK (length("sms_consents"."shown_text") BETWEEN 20 AND 600),
	CONSTRAINT "sms_consents_revoked_after_given" CHECK ("sms_consents"."revoked_at" IS NULL OR "sms_consents"."revoked_at" >= "sms_consents"."given_at")
);
--> statement-breakpoint
ALTER TABLE "sms_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sms_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"segments" smallint NOT NULL,
	"status" text NOT NULL,
	"error_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_deliveries_provider_message_unique" UNIQUE("provider","provider_message_id"),
	CONSTRAINT "sms_deliveries_provider_known" CHECK ("sms_deliveries"."provider" IN ('twilio', 'sandbox')),
	CONSTRAINT "sms_deliveries_provider_message_format" CHECK ("sms_deliveries"."provider_message_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "sms_deliveries_segments_range" CHECK ("sms_deliveries"."segments" BETWEEN 1 AND 10),
	CONSTRAINT "sms_deliveries_status_known" CHECK ("sms_deliveries"."status" IN ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed')),
	CONSTRAINT "sms_deliveries_error_code_range" CHECK ("sms_deliveries"."error_code" BETWEEN 1 AND 999999)
);
--> statement-breakpoint
ALTER TABLE "sms_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sms_keyword_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"phone" text NOT NULL,
	"keyword" text NOT NULL,
	"origin" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_keyword_events_event_unique" UNIQUE("provider","event_id"),
	CONSTRAINT "sms_keyword_events_provider_known" CHECK ("sms_keyword_events"."provider" IN ('twilio', 'sandbox')),
	CONSTRAINT "sms_keyword_events_event_format" CHECK ("sms_keyword_events"."event_id" ~ '^[A-Za-z0-9:_-]{1,100}$'),
	CONSTRAINT "sms_keyword_events_phone_format" CHECK ("sms_keyword_events"."phone" ~ '^[+]1[2-9][0-9]{9}$'),
	CONSTRAINT "sms_keyword_events_keyword_known" CHECK ("sms_keyword_events"."keyword" IN ('stop', 'start', 'help')),
	CONSTRAINT "sms_keyword_events_origin_known" CHECK ("sms_keyword_events"."origin" IN ('keyword', 'provider') AND ("sms_keyword_events"."origin" = 'keyword' OR "sms_keyword_events"."keyword" = 'stop'))
);
--> statement-breakpoint
ALTER TABLE "sms_keyword_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_deliveries" ADD CONSTRAINT "sms_deliveries_message_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."outbox_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_consents_active_unique" ON "sms_consents" USING btree ("tenant_id","phone") WHERE "sms_consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sms_consents_client_idx" ON "sms_consents" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "sms_keyword_events_phone_idx" ON "sms_keyword_events" USING btree ("phone","received_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sms_consents" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sms_deliveries" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "sms_inbound" ON "sms_keyword_events" AS PERMISSIVE FOR ALL TO public USING (COALESCE(current_setting('app.sms_inbound', true) = 'on', false)) WITH CHECK (COALESCE(current_setting('app.sms_inbound', true) = 'on', false));--> statement-breakpoint
CREATE POLICY "operator_access" ON "sms_keyword_events" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
-- The SMS channel (S61, ADR-0065), beyond what drizzle-kit expresses. RLS applies to the table
-- owner too, as for every tenant-owned table (ADR-0010). Keyword events are append-only for the
-- services: an opt-out is never deleted, a START after it is a new row.
ALTER TABLE "sms_consents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sms_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sms_keyword_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "sms_keyword_events" FROM pepper_app;
--> statement-breakpoint
REVOKE TRUNCATE ON "sms_consents", "sms_deliveries" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "sms_deliveries_set_updated_at" BEFORE UPDATE ON "sms_deliveries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Whether a number is opted out of Pepper's texts (AC-X-59): its latest STOP or START is a STOP.
-- Asked at delivery, under the business's tenant, so a definer function that answers a boolean
-- and nothing else (no row of another business's client is ever read back).
CREATE POLICY "keyword_lookup" ON "sms_keyword_events" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION sms_opted_out(p_phone text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT COALESCE((
      SELECT e.keyword = 'stop' FROM sms_keyword_events e
       WHERE e.phone = p_phone AND e.keyword IN ('stop', 'start')
       ORDER BY e.received_at DESC, e.created_at DESC, e.id DESC
       LIMIT 1
    ), false)
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_opted_out(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_opted_out(text) TO pepper_app;
