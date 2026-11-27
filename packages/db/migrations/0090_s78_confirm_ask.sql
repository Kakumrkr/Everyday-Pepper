ALTER TABLE "booking_reminders" DROP CONSTRAINT "booking_reminders_kind_known";--> statement-breakpoint
ALTER TABLE "booking_texts" DROP CONSTRAINT "booking_texts_kind_known";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "client_confirmed_via" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "confirm_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "booking_reminders" ADD CONSTRAINT "booking_reminders_kind_known" CHECK ("booking_reminders"."kind" IN ('confirm_ask', 'day_before', 'same_day'));--> statement-breakpoint
ALTER TABLE "booking_texts" ADD CONSTRAINT "booking_texts_kind_known" CHECK ("booking_texts"."kind" IN ('opt_in', 'confirmation', 'confirm_ask', 'day_before', 'same_day'));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_known" CHECK ("bookings"."cancelled_by" IS NULL OR ("bookings"."status" = 'cancelled' AND "bookings"."cancelled_by" IN ('client', 'business')));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_confirmed_via_known" CHECK ("bookings"."client_confirmed_via" IS NULL OR ("bookings"."client_confirmed_at" IS NOT NULL AND "bookings"."client_confirmed_via" IN ('text', 'link')));--> statement-breakpoint
-- Beyond what drizzle-kit expresses (S78). Like `cancelled_at` (0089), every path keeps the
-- new fields in step, even one that doesn't name them (raw SQL, a later service): any status
-- but cancelled clears who cancelled, and a confirm taken away takes its "how" with it.
CREATE OR REPLACE FUNCTION bookings_keep_cancelled_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := OLD.cancelled_at;
    END IF;
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
  ELSE
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
  END IF;
  IF NEW.client_confirmed_at IS NULL THEN
    NEW.client_confirmed_via := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER "bookings_keep_cancelled_at" ON "bookings";
--> statement-breakpoint
CREATE TRIGGER "bookings_keep_cancelled_at" BEFORE INSERT OR UPDATE OF "status", "cancelled_at",
  "cancelled_by", "client_confirmed_at", "client_confirmed_via"
  ON "bookings" FOR EACH ROW EXECUTE FUNCTION bookings_keep_cancelled_at();
--> statement-breakpoint
-- "C" also answers the confirm ask (S78, AC-X-204): the same lookup with its kind added.
CREATE OR REPLACE FUNCTION sms_confirm_target(p_phone text, p_at timestamptz)
  RETURNS TABLE (tenant_id uuid, booking_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT b.tenant_id, b.id
      FROM booking_texts bt
      JOIN sms_consents c
        ON c.tenant_id = bt.tenant_id AND c.client_id = bt.client_id
       AND c.phone = p_phone AND c.revoked_at IS NULL
      JOIN bookings b ON b.tenant_id = bt.tenant_id AND b.id = bt.booking_id
      JOIN tenants t ON t.id = bt.tenant_id
     WHERE p_phone ~ '^[+]1[2-9][0-9]{9}$'
       AND bt.kind IN ('confirm_ask', 'day_before', 'same_day')
       AND bt.created_at > p_at - interval '48 hours'
       AND bt.created_at <= p_at
       AND b.status = 'confirmed'
       AND b.starts_at = bt.starts_at
       AND b.starts_at > p_at
       AND t.deletion_due_at IS NULL
     ORDER BY (b.client_confirmed_at IS NOT NULL) ASC, b.starts_at ASC, b.id ASC
     LIMIT 1
  $$;
