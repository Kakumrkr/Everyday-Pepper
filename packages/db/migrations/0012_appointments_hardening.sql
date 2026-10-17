-- Hardening of the appointments base tables (ADR-0015), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staff_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staff_services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "working_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "time_off" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "services_set_updated_at" BEFORE UPDATE ON "services"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "staff_members_set_updated_at" BEFORE UPDATE ON "staff_members"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A staff member's login link stays inside the business (tenant in the key, as for every
-- appointments reference). Removing the member unlinks the staff member and nothing else:
-- SET NULL on membership_id only (Postgres 15+), never on tenant_id.
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_membership_fk"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "public"."memberships"("tenant_id", "id")
  ON DELETE SET NULL ("membership_id");
--> statement-breakpoint
-- btree_gist lets one exclusion constraint compare uuids and integers with = next to ranges
-- with && (bookings use it too, Phase 3). A trusted extension: the schema owner may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- A staff member's working intervals on one weekday never overlap (touching is fine: ranges
-- are half-open). The services check this first; the constraint makes it hold under races.
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_no_overlap"
  EXCLUDE USING gist (
    "staff_member_id" WITH =,
    "weekday" WITH =,
    int4range("start_minute", "end_minute") WITH &&
  );
