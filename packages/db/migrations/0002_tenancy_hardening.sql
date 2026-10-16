-- RLS applies to the table owner too (defence in depth; the services never own tables).
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "tenants_set_updated_at" BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "memberships_set_updated_at" BEFORE UPDATE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
