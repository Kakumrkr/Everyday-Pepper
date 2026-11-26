-- Google Calendar reconciliation (S71.2, ADR-0069 §11): where the read-back of "Pepper bookings"
-- stands on each connection, when Pepper last kept a booking over a change made in Google, the
-- feed's `calendar_kept` note, and renames that rewrite events.
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_kind_known";--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "events_sync_token" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "events_page_token" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "events_sync_generation" integer;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "events_sync_calendar_id" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "events_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_event_syncs" ADD COLUMN "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_events_tokens_length" CHECK (char_length("calendar_connections"."events_sync_token") BETWEEN 1 AND 4096 AND char_length("calendar_connections"."events_page_token") BETWEEN 1 AND 4096 AND char_length("calendar_connections"."events_sync_calendar_id") BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_kind_known" CHECK ("feed_items"."kind" IN ('schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload', 'waitlist_match', 'daily_briefing', 'calendar_kept'));--> statement-breakpoint
-- Beyond what drizzle-kit expresses. A service or a client renamed rewrites the events of their
-- bookings that haven't ended (AC-X-178), whatever the path renamed them: the sync rows' versions
-- rise, so the worker writes those bookings again. Runs as the caller (SECURITY INVOKER): the
-- business's own policies apply. Bookings without a row (no calendar that takes bookings) are
-- untouched.
CREATE FUNCTION touch_calendar_event_syncs_of_rename() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE calendar_event_syncs s
    SET version = s.version + 1, due_at = NULL, attempts = 0, last_error = NULL
    FROM bookings b
    WHERE s.tenant_id = NEW.tenant_id AND b.tenant_id = NEW.tenant_id AND b.id = s.booking_id
      AND b.ends_at > now()
      AND (CASE WHEN TG_TABLE_NAME = 'services' THEN b.service_id ELSE b.client_id END) = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "services_touch_calendar_event_syncs"
  AFTER UPDATE OF "name" ON "services"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION touch_calendar_event_syncs_of_rename();
--> statement-breakpoint
CREATE TRIGGER "clients_touch_calendar_event_syncs"
  AFTER UPDATE OF "name" ON "clients"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION touch_calendar_event_syncs_of_rename();
