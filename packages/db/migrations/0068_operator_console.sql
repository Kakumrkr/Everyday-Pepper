ALTER TYPE "public"."audit_actor_kind" ADD VALUE 'operator';--> statement-breakpoint
CREATE TABLE "operator_access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid,
	"txid" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_access_log_action_known" CHECK ("operator_access_log"."action" IN ('inbox.read', 'thread.read', 'thread.reply', 'thread.note', 'thread.status', 'public.read', 'public.note', 'public.status'))
);
--> statement-breakpoint
CREATE TABLE "platform_operators" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid,
	"public_request_id" uuid,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_notes_one_request" CHECK (("support_notes"."thread_id" IS NULL) <> ("support_notes"."public_request_id" IS NULL)),
	CONSTRAINT "support_notes_body_length" CHECK (length("support_notes"."body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "support_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public_support_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_system_has_no_user";--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "pepper_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notes" ADD CONSTRAINT "support_notes_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notes" ADD CONSTRAINT "support_notes_public_request_id_public_support_requests_id_fk" FOREIGN KEY ("public_request_id") REFERENCES "public"."public_support_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_notes" ADD CONSTRAINT "support_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_access_log_txid_idx" ON "operator_access_log" USING btree ("txid","operator_user_id");--> statement-breakpoint
CREATE INDEX "operator_access_log_created_idx" ON "operator_access_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_notes_thread_idx" ON "support_notes" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "support_notes_public_idx" ON "support_notes" USING btree ("public_request_id","created_at");--> statement-breakpoint
CREATE INDEX "support_notes_author_idx" ON "support_notes" USING btree ("author_user_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_system_has_no_user" CHECK ("audit_log"."actor_kind" IN ('user', 'ai_on_behalf_of') OR "audit_log"."actor_user_id" IS NULL);--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD CONSTRAINT "public_support_requests_status_known" CHECK ("public_support_requests"."status" IN ('open', 'answered', 'solved'));--> statement-breakpoint
-- The operator console (S59.2, ADR-0062), beyond what drizzle-kit expresses. An operator is
-- an account in platform_operators (granted by the `operator` script on this role). The
-- services' role never reads that table or the access log: it asks is_platform_operator(), and
-- opens an operator transaction with begin_operator_access(), which checks the grant, writes
-- the access log row and names the operator for the rest of the transaction. The operator_*
-- policies then pass only while current_operator_id() finds that row in this transaction: a
-- support row can't be read across businesses without its record.
REVOKE ALL ON "platform_operators" FROM pepper_app;
--> statement-breakpoint
REVOKE ALL ON "operator_access_log" FROM pepper_app;
--> statement-breakpoint
CREATE FUNCTION is_platform_operator(p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM platform_operators WHERE user_id = p_user) $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION is_platform_operator(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION is_platform_operator(uuid) TO pepper_app;
--> statement-breakpoint
CREATE FUNCTION begin_operator_access(p_id uuid, p_operator uuid, p_action text, p_target uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  named text := NULLIF(current_setting('app.operator_id', true), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_operators WHERE user_id = p_operator) THEN
    RAISE EXCEPTION 'not a Pepper operator' USING ERRCODE = '42501';
  END IF;
  IF named IS NOT NULL AND named <> p_operator::text THEN
    RAISE EXCEPTION 'the transaction belongs to another operator' USING ERRCODE = '42501';
  END IF;
  INSERT INTO operator_access_log (id, operator_user_id, action, target_id, txid)
       VALUES (p_id, p_operator, p_action, p_target, txid_current());
  PERFORM set_config('app.operator_id', p_operator::text, true);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION begin_operator_access(uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION begin_operator_access(uuid, uuid, text, uuid) TO pepper_app;
--> statement-breakpoint
-- The operator of the transaction: NULL unless begin_operator_access() ran in this very
-- transaction for a still-granted operator (setting app.operator_id by hand opens nothing).
CREATE FUNCTION current_operator_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.user_id FROM platform_operators o
     WHERE o.user_id = NULLIF(current_setting('app.operator_id', true), '')::uuid
       AND EXISTS (SELECT 1 FROM operator_access_log l
                    WHERE l.txid = txid_current_if_assigned() AND l.operator_user_id = o.user_id)
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION current_operator_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_operator_id() TO pepper_app;
--> statement-breakpoint
-- The businesses' names, for the inbox only: nothing else of a business, and only to an
-- operator's logged transaction.
CREATE FUNCTION operator_business_names(p_ids uuid[]) RETURNS TABLE (id uuid, name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  tenant text := current_setting('app.tenant_id', true);
  wanted uuid;
BEGIN
  IF (SELECT current_operator_id()) IS NULL THEN
    RETURN;
  END IF;
  -- tenants keeps its forced RLS for this function's owner too: read each business as itself.
  FOREACH wanted IN ARRAY p_ids LOOP
    PERFORM set_config('app.tenant_id', wanted::text, true);
    RETURN QUERY SELECT t.id, t.name FROM tenants t WHERE t.id = wanted;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(tenant, ''), true);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION operator_business_names(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_business_names(uuid[]) TO pepper_app;
--> statement-breakpoint
CREATE POLICY "public_submit" ON "public_support_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "operator_access" ON "public_support_requests" AS PERMISSIVE FOR ALL TO public USING ((SELECT current_operator_id()) IS NOT NULL) WITH CHECK ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "operator_read" ON "support_messages" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "operator_read" ON "support_threads" AS PERMISSIVE FOR SELECT TO public USING ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
CREATE POLICY "operator_access" ON "support_notes" AS PERMISSIVE FOR ALL TO public USING ((SELECT current_operator_id()) IS NOT NULL) WITH CHECK ((SELECT current_operator_id()) IS NOT NULL);
--> statement-breakpoint
-- RLS applies to the table owner too (ADR-0010); notes are append-only for the services; the
-- public form only inserts (its rows are an operator's to read and move).
ALTER TABLE "support_notes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public_support_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "support_notes" FROM pepper_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "public_support_requests" FROM pepper_app;
