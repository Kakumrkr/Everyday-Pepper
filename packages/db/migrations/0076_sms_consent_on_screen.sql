ALTER TABLE "booking_verifications" ADD COLUMN "sms_consent_version" text;--> statement-breakpoint
CREATE INDEX "sms_consents_phone_active_idx" ON "sms_consents" USING btree ("phone","given_at") WHERE "sms_consents"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "booking_verifications" ADD CONSTRAINT "booking_verifications_sms_consent" CHECK ("booking_verifications"."sms_consent_version" IS NULL OR ("booking_verifications"."sms_consent_version" ~ '^sms-consent-v[0-9]{1,3}$' AND "booking_verifications"."purpose" = 'booking' AND "booking_verifications"."phone" ~ '^[+]1[2-9][0-9]{9}$'));
--> statement-breakpoint
-- SMS consent on screen (S61.2, AC-X-68), beyond what drizzle-kit expresses. A reply to Pepper's
-- one number names the businesses that number said yes to. The webhook has no business to bind
-- to, so a definer function answers the names (at most two, the latest consent first) and
-- nothing else: never a client, a consent's words or another number. A business being deleted
-- is left out (its texts stopped when deletion was asked, ADR-0054).
CREATE POLICY "sms_reply_lookup" ON "sms_consents" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY "sms_reply_lookup" ON "tenants" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION sms_consent_businesses(p_phone text) RETURNS TABLE (name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.name
      FROM sms_consents c
      JOIN tenants t ON t.id = c.tenant_id
     WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
       AND c.phone = p_phone
       AND c.revoked_at IS NULL
       AND t.deletion_due_at IS NULL
     ORDER BY c.given_at DESC, c.id DESC
     LIMIT 2
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_consent_businesses(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_consent_businesses(text) TO pepper_app;
