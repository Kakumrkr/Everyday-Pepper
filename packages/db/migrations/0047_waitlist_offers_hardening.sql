-- Hardening of the smart waitlist's tables (S37, ADR-0041), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "waitlist_matches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_offers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "waitlist_matches_set_updated_at" BEFORE UPDATE ON "waitlist_matches"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "waitlist_offers_set_updated_at" BEFORE UPDATE ON "waitlist_offers"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
