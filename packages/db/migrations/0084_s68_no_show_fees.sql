-- No-show fees by approval (S68, ADR-0068 amendment): the terms kept with a booking's payment,
-- the fee record, and `payment.no_show_fee` on the dial.
CREATE TABLE "booking_fees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"booking_id" uuid NOT NULL,
	"booking_payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"policy_sentence" text NOT NULL,
	"agreed_at" timestamp with time zone NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"intent_id" text,
	"refund_id" text,
	"failure_code" text,
	"charged_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_fees_provider_known" CHECK ("booking_fees"."provider" IN ('stripe', 'sandbox')),
	CONSTRAINT "booking_fees_sandbox_not_live" CHECK ("booking_fees"."provider" = 'stripe' OR NOT "booking_fees"."livemode"),
	CONSTRAINT "booking_fees_amount" CHECK ("booking_fees"."amount_cents" BETWEEN 50 AND 10000000),
	CONSTRAINT "booking_fees_currency" CHECK ("booking_fees"."currency" = 'usd'),
	CONSTRAINT "booking_fees_policy_sentence_length" CHECK (char_length("booking_fees"."policy_sentence") BETWEEN 1 AND 500),
	CONSTRAINT "booking_fees_status_known" CHECK ("booking_fees"."status" IN ('queued', 'charging', 'charged', 'failed', 'cancelled', 'refund_pending', 'refunded', 'refund_failed')),
	CONSTRAINT "booking_fees_intent_format" CHECK ("booking_fees"."intent_id" ~ '^pi_[A-Za-z0-9]{1,100}$'),
	CONSTRAINT "booking_fees_refund_format" CHECK ("booking_fees"."refund_id" ~ '^re_[A-Za-z0-9]{1,100}$'),
	CONSTRAINT "booking_fees_failure_code" CHECK ("booking_fees"."failure_code" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "booking_fees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_action_executions" DROP CONSTRAINT "ai_action_executions_action_known";--> statement-breakpoint
ALTER TABLE "ai_action_proposals" DROP CONSTRAINT "ai_action_proposals_action_known";--> statement-breakpoint
ALTER TABLE "autonomy_settings" DROP CONSTRAINT "autonomy_settings_levels_known";--> statement-breakpoint
ALTER TABLE "booking_payments" ADD COLUMN "policy_sentence" text;--> statement-breakpoint
ALTER TABLE "booking_payments" ADD COLUMN "no_show_fee_cents" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payments_tenant_id_unique" ON "booking_payments" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "booking_fees" ADD CONSTRAINT "booking_fees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_fees" ADD CONSTRAINT "booking_fees_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_fees" ADD CONSTRAINT "booking_fees_payment_fk" FOREIGN KEY ("tenant_id","booking_payment_id") REFERENCES "public"."booking_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_fees_booking_unique" ON "booking_fees" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_fees_intent_unique" ON "booking_fees" USING btree ("provider","intent_id") WHERE "booking_fees"."intent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_action_executions" ADD CONSTRAINT "ai_action_executions_action_known" CHECK ("ai_action_executions"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking.no_show', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'waitlist.change', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk', 'message.review_request', 'message.client', 'payment.no_show_fee'));--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_action_known" CHECK ("ai_action_proposals"."action" IN ('booking.create', 'booking.move', 'booking.cancel', 'booking.no_show', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'waitlist.change', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk', 'message.review_request', 'message.client', 'payment.no_show_fee'));--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "autonomy_settings_levels_known" CHECK (jsonb_typeof("autonomy_settings"."levels") = 'object' AND "autonomy_settings"."levels" - ARRAY['booking.create', 'booking.move', 'booking.cancel', 'booking.no_show', 'booking_request.accept', 'time.block', 'client_note.save', 'rule.change', 'task.create', 'waitlist.change', 'message.confirmation', 'message.rebooking_nudge', 'message.waitlist_offer', 'message.bulk', 'message.review_request', 'message.client', 'payment.no_show_fee'] = '{}'::jsonb AND NOT jsonb_path_exists("autonomy_settings"."levels", '$.* ? (@ != "ask" && @ != "notify" && @ != "auto")'));--> statement-breakpoint
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_no_show_fee" CHECK ("booking_payments"."no_show_fee_cents" IS NULL OR ("booking_payments"."no_show_fee_cents" BETWEEN 50 AND 10000000 AND "booking_payments"."policy_sentence" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_policy_sentence_length" CHECK ("booking_payments"."policy_sentence" IS NULL OR char_length("booking_payments"."policy_sentence") BETWEEN 1 AND 500);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_fees" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Beyond what drizzle-kit expresses. RLS applies to the table owner too (ADR-0010). A fee is the
-- business's record for a dispute: never deleted by the services; it goes with the business.
ALTER TABLE "booking_fees" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "booking_fees" FROM pepper_app;
--> statement-breakpoint
CREATE TRIGGER "booking_fees_set_updated_at" BEFORE UPDATE ON "booking_fees"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
