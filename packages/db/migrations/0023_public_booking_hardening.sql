-- Hardening of booking_verifications (ADR-0022), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "booking_verifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "booking_verifications_set_updated_at" BEFORE UPDATE ON "booking_verifications"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
