ALTER TABLE "clients" ADD COLUMN "email_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "insight_runs" ADD COLUMN "drafts_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mailing_address" text;--> statement-breakpoint
CREATE INDEX "insight_runs_drafts_due_at_idx" ON "insight_runs" USING btree ("drafts_due_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_mailing_address_length" CHECK (length("tenants"."mailing_address") BETWEEN 5 AND 300);