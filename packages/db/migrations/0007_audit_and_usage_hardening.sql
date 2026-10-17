-- Hardening of the audit log and usage meters (ADR-0013), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_meters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The audit log is append-only for the services: the default privileges (migration 0000) gave
-- floty_app every write. Deleting a tenant or a user still cascades or nulls entries, because
-- foreign key actions run as the table owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM floty_app;
--> statement-breakpoint
CREATE TRIGGER "usage_meters_set_updated_at" BEFORE UPDATE ON "usage_meters"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
