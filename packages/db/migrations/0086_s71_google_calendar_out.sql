-- Google Calendar out (S71, ADR-0069 §10): whether a connection writes bookings and its "Pepper
-- bookings" calendar, and one sync row per booking written there, kept by a trigger on bookings.
CREATE TABLE "calendar_event_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"booking_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"synced_version" integer,
	"event_connection_id" uuid,
	"event_calendar_id" text,
	"due_at" timestamp with time zone,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_syncs_version_range" CHECK ("calendar_event_syncs"."version" >= 1),
	CONSTRAINT "calendar_event_syncs_attempts_range" CHECK ("calendar_event_syncs"."attempts" >= 0),
	CONSTRAINT "calendar_event_syncs_error_format" CHECK ("calendar_event_syncs"."last_error" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "calendar_event_syncs_event_pair" CHECK (("calendar_event_syncs"."event_connection_id" IS NULL) = ("calendar_event_syncs"."event_calendar_id" IS NULL)),
	CONSTRAINT "calendar_event_syncs_calendar_length" CHECK (char_length("calendar_event_syncs"."event_calendar_id") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "calendar_event_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "writes_bookings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "bookings_calendar_id" text;--> statement-breakpoint
ALTER TABLE "calendar_event_syncs" ADD CONSTRAINT "calendar_event_syncs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_syncs_booking_unique" ON "calendar_event_syncs" USING btree ("tenant_id","booking_id");--> statement-breakpoint
CREATE INDEX "calendar_event_syncs_due_idx" ON "calendar_event_syncs" USING btree ("due_at") WHERE "calendar_event_syncs"."synced_version" IS DISTINCT FROM "calendar_event_syncs"."version";--> statement-breakpoint
CREATE INDEX "calendar_event_syncs_connection_idx" ON "calendar_event_syncs" USING btree ("tenant_id","event_connection_id");--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_bookings_calendar_length" CHECK (char_length("calendar_connections"."bookings_calendar_id") BETWEEN 1 AND 1024);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_event_syncs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "job_scan" ON "calendar_event_syncs" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('calendar'));--> statement-breakpoint
-- Beyond what drizzle-kit expresses. RLS applies to the table owner too (ADR-0010).
ALTER TABLE "calendar_event_syncs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "calendar_event_syncs_set_updated_at" BEFORE UPDATE ON "calendar_event_syncs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Every write of a booking, whatever the path (the team, the booking page, Pepper, an import, an
-- undo), raises its sync row's version, so the worker writes it again (AC-X-168). A booking gets a
-- row when its staff member's calendar takes bookings; once it has one, every later change
-- (another staff member, a cancel, a removal) is followed, so its event can be moved or removed.
-- Runs as the caller (SECURITY INVOKER): the business's own policies apply. An update that
-- changes nothing the event shows is skipped.
CREATE FUNCTION touch_calendar_event_sync() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
DECLARE
  booking_tenant uuid;
  booking uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    booking_tenant := OLD.tenant_id;
    booking := OLD.id;
  ELSE
    booking_tenant := NEW.tenant_id;
    booking := NEW.id;
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at
    AND NEW.status = OLD.status AND NEW.staff_member_id = OLD.staff_member_id
    AND NEW.service_id = OLD.service_id AND NEW.client_id = OLD.client_id THEN
    RETURN NULL;
  END IF;
  UPDATE calendar_event_syncs
    SET version = version + 1, due_at = NULL, attempts = 0, last_error = NULL
    WHERE tenant_id = booking_tenant AND booking_id = booking;
  IF NOT FOUND AND TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM calendar_connections c
    WHERE c.tenant_id = NEW.tenant_id AND c.staff_member_id = NEW.staff_member_id
      AND c.writes_bookings
  ) THEN
    INSERT INTO calendar_event_syncs (id, tenant_id, booking_id)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.id)
    ON CONFLICT (tenant_id, booking_id) DO UPDATE
      SET version = calendar_event_syncs.version + 1, due_at = NULL, attempts = 0,
        last_error = NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "bookings_touch_calendar_event_sync"
  AFTER INSERT OR UPDATE OR DELETE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION touch_calendar_event_sync();
