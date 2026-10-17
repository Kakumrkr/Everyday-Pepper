-- Auth tables (ADR-0012) are global: no tenant_id and no RLS, because Better Auth looks up users
-- and sessions before any tenant or user is known. They are classified as global, with a
-- reason, in the cross-tenant isolation suite.
CREATE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "sessions_set_updated_at" BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "accounts_set_updated_at" BEFORE UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "verifications_set_updated_at" BEFORE UPDATE ON "verifications"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "two_factors_set_updated_at" BEFORE UPDATE ON "two_factors"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
