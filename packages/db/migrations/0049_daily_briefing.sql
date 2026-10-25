ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_kind_known";--> statement-breakpoint
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_subject_key_format";--> statement-breakpoint
ALTER TABLE "insight_runs" ADD COLUMN "briefing_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "insight_runs_briefing_due_at_idx" ON "insight_runs" USING btree ("briefing_due_at");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_kind_known" CHECK ("feed_items"."kind" IN ('schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload', 'waitlist_match', 'daily_briefing'));--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_subject_key_format" CHECK ("feed_items"."subject_key" ~ '^(staff|client|booking|business):[0-9a-f-]{36}$');