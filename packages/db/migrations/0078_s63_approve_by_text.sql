CREATE TABLE "approval_texts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"fingerprint" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_texts_phone_format" CHECK ("approval_texts"."phone" ~ '^[+]1[2-9][0-9]{9}$'),
	CONSTRAINT "approval_texts_code_hash_format" CHECK ("approval_texts"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "approval_texts_used_after_created" CHECK ("approval_texts"."used_at" IS NULL OR "approval_texts"."used_at" >= "approval_texts"."created_at")
);
--> statement-breakpoint
ALTER TABLE "approval_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_phones" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"phone" text,
	"verified_at" timestamp with time zone,
	"check_phone" text,
	"check_hash" text,
	"check_expires_at" timestamp with time zone,
	"check_attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_phones_phone_format" CHECK ("user_phones"."phone" ~ '^[+]1[2-9][0-9]{9}$'),
	CONSTRAINT "user_phones_check_phone_format" CHECK ("user_phones"."check_phone" ~ '^[+]1[2-9][0-9]{9}$'),
	CONSTRAINT "user_phones_verified_with_phone" CHECK (("user_phones"."phone" IS NULL) = ("user_phones"."verified_at" IS NULL)),
	CONSTRAINT "user_phones_check_complete" CHECK (("user_phones"."check_phone" IS NULL) = ("user_phones"."check_hash" IS NULL) AND ("user_phones"."check_hash" IS NULL) = ("user_phones"."check_expires_at" IS NULL)),
	CONSTRAINT "user_phones_check_hash_format" CHECK ("user_phones"."check_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "user_phones_check_attempts_range" CHECK ("user_phones"."check_attempts" BETWEEN 0 AND 10)
);
--> statement-breakpoint
DROP INDEX "sms_consents_active_unique";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "card_texts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_texts" ADD CONSTRAINT "approval_texts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_texts" ADD CONSTRAINT "approval_texts_message_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."outbox_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_texts" ADD CONSTRAINT "approval_texts_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."ai_action_proposals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_phones" ADD CONSTRAINT "user_phones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_texts_phone_idx" ON "approval_texts" USING btree ("phone","expires_at");--> statement-breakpoint
CREATE INDEX "approval_texts_proposal_idx" ON "approval_texts" USING btree ("tenant_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_consents_active_unique" ON "sms_consents" USING btree ("tenant_id","phone","source") WHERE "sms_consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_texts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Approve by text (S63, ADR-0066), beyond what drizzle-kit expresses. RLS applies to the table
-- owner too, as for every tenant-owned table (ADR-0010).
ALTER TABLE "approval_texts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON "approval_texts" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "user_phones_set_updated_at" BEFORE UPDATE ON "user_phones"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- "Y" and a code (AC-X-83…85). A reply reaches Pepper's one number with no business to bind
-- to, so a definer function answers which text it answers (ids only, never a proposal, a member
-- or a business's name): the text sent to this number whose code's HMAC matches, live (unused,
-- unexpired) first, else one expired or used in the last day (to say so), the newest first. A
-- business being deleted is left out. `live` also lets a new code avoid one in force.
CREATE POLICY "sms_approval_lookup" ON "approval_texts" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION sms_approval_target(p_phone text, p_code_hash text, p_at timestamptz)
  RETURNS TABLE (tenant_id uuid, approval_text_id uuid, live boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.tenant_id, a.id, (a.used_at IS NULL AND a.expires_at > p_at)
      FROM approval_texts a
      JOIN tenants t ON t.id = a.tenant_id
     WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
       AND p_code_hash ~ '^[0-9a-f]{64}$'
       AND a.phone = p_phone
       AND a.code_hash = p_code_hash
       AND a.expires_at > p_at - interval '1 day'
       AND a.created_at <= p_at
       AND t.deletion_due_at IS NULL
     ORDER BY (a.used_at IS NULL AND a.expires_at > p_at) DESC, a.created_at DESC, a.id DESC
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION sms_approval_target(text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sms_approval_target(text, text, timestamptz) TO pepper_app;
