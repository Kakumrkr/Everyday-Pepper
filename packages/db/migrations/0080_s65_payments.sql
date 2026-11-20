CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"generation" smallint DEFAULT 1 NOT NULL,
	"livemode" boolean NOT NULL,
	"status" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"currently_due" text[] DEFAULT '{}'::text[] NOT NULL,
	"past_due" text[] DEFAULT '{}'::text[] NOT NULL,
	"eventually_due" text[] DEFAULT '{}'::text[] NOT NULL,
	"pending_verification" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_deadline" timestamp with time zone,
	"disabled_reason" text,
	"synced_at" timestamp with time zone,
	"deauthorized_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_provider_known" CHECK ("payment_accounts"."provider" IN ('stripe', 'sandbox')),
	CONSTRAINT "payment_accounts_account_format" CHECK ("payment_accounts"."provider_account_id" ~ '^acct_[A-Za-z0-9]{1,64}$'),
	CONSTRAINT "payment_accounts_generation_range" CHECK ("payment_accounts"."generation" BETWEEN 1 AND 1000),
	CONSTRAINT "payment_accounts_status_known" CHECK ("payment_accounts"."status" IN ('not_connected', 'onboarding', 'pending', 'action_needed', 'ready', 'rejected')),
	CONSTRAINT "payment_accounts_requirements_size" CHECK (cardinality("payment_accounts"."currently_due") <= 100 AND cardinality("payment_accounts"."past_due") <= 100 AND cardinality("payment_accounts"."eventually_due") <= 100 AND cardinality("payment_accounts"."pending_verification") <= 100),
	CONSTRAINT "payment_accounts_disabled_reason_format" CHECK ("payment_accounts"."disabled_reason" ~ '^[a-z_.]{1,100}$'),
	CONSTRAINT "payment_accounts_sandbox_not_live" CHECK ("payment_accounts"."provider" = 'stripe' OR NOT "payment_accounts"."livemode")
);
--> statement-breakpoint
ALTER TABLE "payment_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"account_id" text,
	"livemode" boolean NOT NULL,
	"tenant_id" uuid,
	"outcome" text DEFAULT 'received' NOT NULL,
	"ignored_reason" text,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"created_at_provider" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_webhook_events_event_unique" UNIQUE("provider","event_id"),
	CONSTRAINT "payment_webhook_events_provider_known" CHECK ("payment_webhook_events"."provider" IN ('stripe', 'sandbox')),
	CONSTRAINT "payment_webhook_events_event_format" CHECK ("payment_webhook_events"."event_id" ~ '^evt_[A-Za-z0-9_]{1,100}$'),
	CONSTRAINT "payment_webhook_events_type_format" CHECK ("payment_webhook_events"."event_type" ~ '^[a-z0-9_.]{1,100}$'),
	CONSTRAINT "payment_webhook_events_account_format" CHECK ("payment_webhook_events"."account_id" ~ '^acct_[A-Za-z0-9]{1,64}$'),
	CONSTRAINT "payment_webhook_events_outcome_known" CHECK ("payment_webhook_events"."outcome" IN ('received', 'processed', 'ignored')),
	CONSTRAINT "payment_webhook_events_ignored_reason" CHECK (("payment_webhook_events"."outcome" = 'ignored') = ("payment_webhook_events"."ignored_reason" IS NOT NULL) AND ("payment_webhook_events"."ignored_reason" IS NULL OR "payment_webhook_events"."ignored_reason" IN ('unknown_account', 'other_mode', 'unhandled_type', 'no_account', 'unreadable_account'))),
	CONSTRAINT "payment_webhook_events_processed_when_done" CHECK (("payment_webhook_events"."outcome" = 'received') = ("payment_webhook_events"."processed_at" IS NULL)),
	CONSTRAINT "payment_webhook_events_attempts_range" CHECK ("payment_webhook_events"."attempts" BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_tenant_unique" ON "payment_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_provider_account_unique" ON "payment_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_received_idx" ON "payment_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_accounts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "payments_webhook" ON "payment_webhook_events" AS PERMISSIVE FOR ALL TO public USING (COALESCE(current_setting('app.payments_webhook', true) = 'on', false)) WITH CHECK (COALESCE(current_setting('app.payments_webhook', true) = 'on', false));--> statement-breakpoint
CREATE POLICY "operator_access" ON "payment_webhook_events" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
-- Payments (S65, ADR-0067), beyond what drizzle-kit expresses. RLS applies to the table owner
-- too, as for every tenant-owned table (ADR-0010). A business's account row is never deleted by
-- the services (Stripe disconnecting it is a date on the row); it goes with the business.
ALTER TABLE "payment_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "payment_accounts" FROM pepper_app;
--> statement-breakpoint
REVOKE TRUNCATE ON "payment_webhook_events" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "payment_accounts_set_updated_at" BEFORE UPDATE ON "payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Which business a Stripe account belongs to (AC-X-97). A webhook names a Stripe account, not
-- a business, and arrives with none bound, so a definer function answers the tenant id for the
-- stored account id and nothing else (never a row). The event's body and metadata are never
-- trusted for it. A business being deleted is left out.
CREATE POLICY "payment_account_lookup" ON "payment_accounts" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION payment_account_tenant(p_provider text, p_account text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.tenant_id FROM payment_accounts a
      JOIN tenants t ON t.id = a.tenant_id
     WHERE a.provider = p_provider AND a.provider_account_id = p_account
       AND t.deletion_due_at IS NULL
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION payment_account_tenant(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payment_account_tenant(text, text) TO pepper_app;
