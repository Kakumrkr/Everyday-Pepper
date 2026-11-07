CREATE TABLE "support_screenshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"uploaded_by_user_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"widths" integer[] NOT NULL,
	"bytes" integer NOT NULL,
	"attached_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_screenshots_attached" CHECK (("support_screenshots"."thread_id" IS NULL) = ("support_screenshots"."message_id" IS NULL) AND ("support_screenshots"."thread_id" IS NULL) = ("support_screenshots"."attached_at" IS NULL)),
	CONSTRAINT "support_screenshots_discarded_unsent" CHECK ("support_screenshots"."discarded_at" IS NULL OR "support_screenshots"."thread_id" IS NULL),
	CONSTRAINT "support_screenshots_size" CHECK ("support_screenshots"."width" BETWEEN 1 AND 100000 AND "support_screenshots"."height" BETWEEN 1 AND 100000 AND "support_screenshots"."bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "support_screenshots_widths" CHECK (cardinality("support_screenshots"."widths") BETWEEN 1 AND 4 AND 0 < ALL("support_screenshots"."widths") AND 4097 > ALL("support_screenshots"."widths"))
);
--> statement-breakpoint
ALTER TABLE "support_screenshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operator_access_log" DROP CONSTRAINT "operator_access_log_action_known";--> statement-breakpoint
ALTER TABLE "support_screenshots" ADD CONSTRAINT "support_screenshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_screenshots" ADD CONSTRAINT "support_screenshots_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenant_thread_id_unique" UNIQUE("tenant_id","thread_id","id");--> statement-breakpoint
ALTER TABLE "support_screenshots" ADD CONSTRAINT "support_screenshots_message_fk" FOREIGN KEY ("tenant_id","thread_id","message_id") REFERENCES "public"."support_messages"("tenant_id","thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_screenshots_message_idx" ON "support_screenshots" USING btree ("tenant_id","thread_id","message_id");--> statement-breakpoint
CREATE INDEX "support_screenshots_uploader_idx" ON "support_screenshots" USING btree ("uploaded_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "support_screenshots_created_idx" ON "support_screenshots" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "operator_access_log" ADD CONSTRAINT "operator_access_log_action_known" CHECK ("operator_access_log"."action" IN ('inbox.read', 'thread.read', 'thread.reply', 'thread.note', 'thread.status', 'public.read', 'public.note', 'public.status', 'replies.read', 'replies.write', 'screenshot.read'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "support_screenshots" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "support_screenshots" AS RESTRICTIVE FOR ALL TO public USING (CASE WHEN thread_id IS NULL THEN current_user_id() IS NULL OR uploaded_by_user_id = current_user_id() ELSE thread_id IN (SELECT id FROM support_threads) END) WITH CHECK (CASE WHEN thread_id IS NULL THEN current_user_id() IS NULL OR uploaded_by_user_id = current_user_id() ELSE thread_id IN (SELECT id FROM support_threads) END);--> statement-breakpoint
CREATE POLICY "member_scope_unsent_delete" ON "support_screenshots" AS RESTRICTIVE FOR DELETE TO public USING (thread_id IS NULL);--> statement-breakpoint
CREATE POLICY "operator_read" ON "support_screenshots" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL AND thread_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY "job_scan" ON "support_screenshots" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('support'));--> statement-breakpoint
-- Screenshots on a request (S59.2.3, ADR-0062 Part 3), beyond what drizzle-kit expresses: RLS
-- applies to the table owner too (ADR-0010); a screenshot changes only from unsent to sent
-- (once) or discarded (once), and otherwise only loses its uploader when their account goes.
ALTER TABLE "support_screenshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON "support_screenshots" FROM pepper_app;
--> statement-breakpoint
CREATE FUNCTION support_screenshots_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.width <> OLD.width
     OR NEW.height <> OLD.height OR NEW.widths <> OLD.widths OR NEW.bytes <> OLD.bytes
     OR NEW.created_at <> OLD.created_at
     OR (NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id
         AND NEW.uploaded_by_user_id IS NOT NULL)
     OR (OLD.thread_id IS NOT NULL AND (NEW.thread_id IS DISTINCT FROM OLD.thread_id
         OR NEW.message_id IS DISTINCT FROM OLD.message_id
         OR NEW.attached_at IS DISTINCT FROM OLD.attached_at
         OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at))
     OR (OLD.discarded_at IS NOT NULL AND (NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
         OR NEW.thread_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'a support screenshot can''t change once sent or discarded'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "support_screenshots_guard" BEFORE UPDATE ON "support_screenshots"
  FOR EACH ROW EXECUTE FUNCTION support_screenshots_guard();
