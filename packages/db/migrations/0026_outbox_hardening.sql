-- Hardening of the outbox (ADR-0024), beyond what drizzle-kit expresses.

-- RLS applies to the table owner too (as for every tenant-owned table, ADR-0010).
ALTER TABLE "outbox_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbox_dispatch" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "outbox_messages_set_updated_at" BEFORE UPDATE ON "outbox_messages"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
