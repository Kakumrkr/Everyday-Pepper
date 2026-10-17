-- Hardening of the invites table (ADR-0014), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "invites_set_updated_at" BEFORE UPDATE ON "invites"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
