ALTER TYPE "public"."outbox_message_type" ADD VALUE 'payment';--> statement-breakpoint
CREATE TABLE "booking_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"request_id" uuid NOT NULL,
	"booking_id" uuid,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"intent_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"account_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"refund_hours" integer NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"refund_id" text,
	"booked_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_payments_provider_known" CHECK ("booking_payments"."provider" IN ('stripe', 'sandbox')),
	CONSTRAINT "booking_payments_sandbox_not_live" CHECK ("booking_payments"."provider" = 'stripe' OR NOT "booking_payments"."livemode"),
	CONSTRAINT "booking_payments_kind_known" CHECK ("booking_payments"."kind" IN ('deposit', 'card')),
	CONSTRAINT "booking_payments_intent_format" CHECK (("booking_payments"."kind" = 'deposit' AND "booking_payments"."intent_id" ~ '^pi_[A-Za-z0-9]{1,100}$') OR ("booking_payments"."kind" = 'card' AND "booking_payments"."intent_id" ~ '^seti_[A-Za-z0-9]{1,100}$')),
	CONSTRAINT "booking_payments_customer_format" CHECK ("booking_payments"."customer_id" ~ '^cus_[A-Za-z0-9]{1,100}$'),
	CONSTRAINT "booking_payments_account_format" CHECK ("booking_payments"."account_id" ~ '^acct_[A-Za-z0-9]{1,64}$'),
	CONSTRAINT "booking_payments_amount" CHECK (("booking_payments"."kind" = 'deposit' AND "booking_payments"."amount_cents" BETWEEN 50 AND 10000000) OR ("booking_payments"."kind" = 'card' AND "booking_payments"."amount_cents" = 0)),
	CONSTRAINT "booking_payments_currency" CHECK ("booking_payments"."currency" = 'usd'),
	CONSTRAINT "booking_payments_refund_hours_range" CHECK ("booking_payments"."refund_hours" BETWEEN 0 AND 168),
	CONSTRAINT "booking_payments_status_known" CHECK ("booking_payments"."status" IN ('started', 'booked', 'captured', 'card_saved', 'kept', 'refund_pending', 'refunded', 'refund_failed', 'voided', 'capture_failed')),
	CONSTRAINT "booking_payments_booked_has_booking" CHECK (("booking_payments"."status" IN ('started', 'voided')) = ("booking_payments"."booking_id" IS NULL)),
	CONSTRAINT "booking_payments_refund_format" CHECK ("booking_payments"."refund_id" ~ '^re_[A-Za-z0-9]{1,100}$')
);
--> statement-breakpoint
ALTER TABLE "booking_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "deposit_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "deposit_value" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deposit_refund_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payments_request_unique" ON "booking_payments" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payments_booking_unique" ON "booking_payments" USING btree ("tenant_id","booking_id") WHERE "booking_payments"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payments_intent_unique" ON "booking_payments" USING btree ("provider","intent_id");--> statement-breakpoint
CREATE INDEX "booking_payments_open_idx" ON "booking_payments" USING btree ("status","created_at") WHERE "booking_payments"."status" IN ('started', 'booked', 'refund_pending');--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_deposit_rule" CHECK (("services"."deposit_kind" IN ('none', 'card') AND "services"."deposit_value" IS NULL) OR ("services"."deposit_kind" = 'fixed' AND "services"."deposit_value" BETWEEN 50 AND 10000000) OR ("services"."deposit_kind" = 'percent' AND "services"."deposit_value" BETWEEN 1 AND 100 AND "services"."price_from_cents" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_deposit_refund_hours_range" CHECK ("tenants"."deposit_refund_hours" BETWEEN 0 AND 168);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_payments" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Deposits (S66, ADR-0068), beyond what drizzle-kit expresses. RLS applies to the table owner
-- too (ADR-0010). A payment row is never deleted by the services; it goes with the business.
ALTER TABLE "booking_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "booking_payments" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "booking_payments_set_updated_at" BEFORE UPDATE ON "booking_payments"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The payments sweep (AC-X-116) runs without a business: a definer function answers the business
-- and id of payments it looks after (made `p_age` ago and not booked; voided but not yet let go at
-- Stripe; a refund Stripe left pending; the last two untouched for `p_age`), by the database's
-- clock, oldest first, and nothing else. Captures and refunds not yet asked for are the
-- outbox's. Each is then handled in its business's own transaction.
CREATE POLICY "booking_payment_sweep" ON "booking_payments" AS PERMISSIVE FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION open_booking_payments(p_age interval, p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.tenant_id, p.id FROM booking_payments p
     WHERE (p.status = 'started' AND p.created_at < now() - p_age)
        OR (p.status = 'voided' AND p.settled_at IS NULL AND p.updated_at < now() - p_age)
        OR (p.status = 'refund_pending' AND p.refund_id IS NOT NULL AND p.updated_at < now() - p_age)
     ORDER BY p.updated_at
     LIMIT LEAST(GREATEST(p_limit, 0), 500)
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION open_booking_payments(interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION open_booking_payments(interval, integer) TO pepper_app;
