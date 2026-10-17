-- Hardening of clients, bookings, booking_occupancy and waitlist_entries (ADR-0017), beyond
-- what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_occupancy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "clients_set_updated_at" BEFORE UPDATE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "bookings_set_updated_at" BEFORE UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "waitlist_entries_set_updated_at" BEFORE UPDATE ON "waitlist_entries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- No double booking: two active bookings of one staff member never occupy overlapping time,
-- buffers included, the same occupied time the availability engine checks (ADR-0016). Ranges
-- are half-open, so a booking may start the moment the previous one's buffer ends. Postgres
-- checks this under concurrency: the second of two racing transactions waits for the first and
-- then fails with exclusion_violation (23P01).
ALTER TABLE "booking_occupancy" ADD CONSTRAINT "booking_occupancy_no_overlap"
  EXCLUDE USING gist ("staff_member_id" WITH =, "occupied" WITH &&);
--> statement-breakpoint
-- Keeps booking_occupancy in step with bookings, in the same statement: a row per booking that
-- is not cancelled, with the time it occupies. Runs as the caller (SECURITY INVOKER), so the
-- occupancy table's own policies apply. Deleting a booking deletes its row (foreign key).
CREATE FUNCTION sync_booking_occupancy() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM booking_occupancy WHERE id = OLD.id;
  END IF;
  IF NEW.status <> 'cancelled' THEN
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
CREATE TRIGGER "bookings_sync_occupancy"
  AFTER INSERT OR UPDATE OF "tenant_id", "staff_member_id", "starts_at", "ends_at",
    "buffer_before_minutes", "buffer_after_minutes", "status"
  ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION sync_booking_occupancy();
