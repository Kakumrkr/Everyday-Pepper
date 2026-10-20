-- Hardening of tasks and push subscriptions (ADR-0026), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "tasks_set_updated_at" BEFORE UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "push_subscriptions_set_updated_at" BEFORE UPDATE ON "push_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The assignee is a member of the business. When they leave, their tasks stay with the
-- business, unassigned: only the assignee column is cleared (Postgres 15+ column list).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_membership_fk"
  FOREIGN KEY ("tenant_id", "assignee_user_id")
  REFERENCES "memberships" ("tenant_id", "user_id")
  ON DELETE SET NULL ("assignee_user_id");
