-- Hardening of the operator feed's tables (ADR-0039), beyond what drizzle-kit expresses.

-- Every business already there gets its first insights run on the worker's next pass; new
-- businesses get their row when they are created (createTenant). Before FORCE, so the
-- migration role (the tables' owner) is not held to the tenant policy.
INSERT INTO "insight_runs" ("id", "tenant_id") SELECT gen_random_uuid(), "id" FROM "tenants";
--> statement-breakpoint
-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "feed_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "insight_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "insight_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "feed_items_set_updated_at" BEFORE UPDATE ON "feed_items"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "insight_runs_set_updated_at" BEFORE UPDATE ON "insight_runs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The proposal that carries an item out (S36). When the proposal goes, the item stays and only
-- the link is cleared (Postgres 15+ column list).
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_action_proposal_fk"
  FOREIGN KEY ("tenant_id", "action_proposal_id")
  REFERENCES "ai_action_proposals" ("tenant_id", "id")
  ON DELETE SET NULL ("action_proposal_id");
--> statement-breakpoint
