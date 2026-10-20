-- Hardening of the booking reminders (ADR-0025), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "booking_reminders" FORCE ROW LEVEL SECURITY;
