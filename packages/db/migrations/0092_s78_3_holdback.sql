-- S78.3 (ADR-0071 §S78.3): the holdback's mark, a visit kept from its early ask so S73 can
-- compare no-shows on asked and held-back visits.
ALTER TABLE "bookings" ADD COLUMN "confirm_held_back_at" timestamp with time zone;