-- Hardening of booking_rules (ADR-0016), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "booking_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- At most one rule of each single-valued type for the business (staff_member_id NULL) and per
-- staff member; blackout windows may repeat. NULLS NOT DISTINCT (Postgres 15+) makes two
-- business-wide rules of one type collide. The services check this first; the index makes it
-- hold under races.
CREATE UNIQUE INDEX "booking_rules_single_valued_unique"
  ON "booking_rules" ("tenant_id", "type", "staff_member_id") NULLS NOT DISTINCT
  WHERE "type" <> 'blackout_window';
