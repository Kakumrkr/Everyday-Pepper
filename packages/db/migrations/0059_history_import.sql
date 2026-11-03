ALTER TABLE "bookings" DROP CONSTRAINT "bookings_source_known";--> statement-breakpoint
ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_outcome_known";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "birthday_month" smallint;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "birthday_day" smallint;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "birthday_year" smallint;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "kind" text DEFAULT 'clients' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "notices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "visit" jsonb;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "created_client" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
CREATE INDEX "bookings_import_batch_idx" ON "bookings" USING btree ("tenant_id","import_batch_id") WHERE "bookings"."import_batch_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_import_batch" CHECK (("bookings"."source" = 'import') = ("bookings"."import_batch_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_source_known" CHECK ("bookings"."source" IN ('team', 'ai', 'booking_page', 'import'));--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tags_shape" CHECK (cardinality("clients"."tags") <= 20 AND array_position("clients"."tags", NULL) IS NULL);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_birthday_shape" CHECK (("clients"."birthday_month" IS NULL) = ("clients"."birthday_day" IS NULL) AND ("clients"."birthday_year" IS NULL OR "clients"."birthday_month" IS NOT NULL) AND "clients"."birthday_month" BETWEEN 1 AND 12 AND "clients"."birthday_day" BETWEEN 1 AND (CASE WHEN "clients"."birthday_month" = 2 THEN 29 WHEN "clients"."birthday_month" IN (4, 6, 9, 11) THEN 30 ELSE 31 END) AND "clients"."birthday_year" BETWEEN 1900 AND 2100);--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_kind_known" CHECK ("import_batches"."kind" IN ('clients', 'visits'));--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_outcome_known" CHECK ("import_rows"."outcome" IN ('create', 'merge', 'unchanged', 'invalid', 'skipped', 'conflict'));--> statement-breakpoint
-- Hardening (S49, ADR-0050), beyond what drizzle-kit expresses. Imported history occupies no
-- time: a past visit brought in from another tool (completed or no-show) is a record, not a
-- claim on the calendar, so history whose bookings overlapped there comes in whole. Everything
-- else is as in migration 0017.
CREATE OR REPLACE FUNCTION sync_booking_occupancy() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM booking_occupancy WHERE id = OLD.id;
  END IF;
  IF NEW.status <> 'cancelled'
    AND NOT (NEW.source = 'import' AND NEW.status IN ('completed', 'no_show')) THEN
    INSERT INTO booking_occupancy (id, tenant_id, staff_member_id, starts_at, ends_at, occupied)
    VALUES (
      NEW.id,
      NEW.tenant_id,
      NEW.staff_member_id,
      NEW.starts_at,
      NEW.ends_at,
      tstzrange(
        NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes),
        NEW.ends_at + make_interval(mins => NEW.buffer_after_minutes),
        '[)'));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Rows of S48's client imports that created their client. Forced RLS would hide every row
-- from the migration (no business in context), so it is lifted for this one statement.
ALTER TABLE "import_rows" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "import_rows" SET "created_client" = true
  WHERE "outcome" = 'create' AND "applied_at" IS NOT NULL AND "client_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;
