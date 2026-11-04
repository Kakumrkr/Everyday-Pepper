-- Overdue regulars fill what the waitlist leaves (S54, ADR-0056): an offer to a regular has no
-- waitlist entry (`source` 'regular'); every earlier offer was the waitlist's. A regular is
-- offered one time once.
ALTER TABLE "waitlist_offers" ALTER COLUMN "entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD COLUMN "source" text DEFAULT 'waitlist' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offers_match_regular_unique" ON "waitlist_offers" USING btree ("tenant_id","match_id","client_id") WHERE "waitlist_offers"."source" = 'regular';--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_source_known" CHECK ("waitlist_offers"."source" IN ('waitlist', 'regular'));--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_source_entry" CHECK (("waitlist_offers"."source" = 'waitlist') = ("waitlist_offers"."entry_id" IS NOT NULL));