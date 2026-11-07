CREATE TABLE "support_saved_replies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_saved_replies_title_length" CHECK (length("support_saved_replies"."title") BETWEEN 1 AND 80),
	CONSTRAINT "support_saved_replies_body_length" CHECK (length("support_saved_replies"."body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "support_saved_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operator_access_log" DROP CONSTRAINT "operator_access_log_action_known";--> statement-breakpoint
ALTER TABLE "public_support_requests" ADD COLUMN "overdue_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "solved_by" text;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "rating" text;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "rated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "overdue_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_saved_replies" ADD CONSTRAINT "support_saved_replies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_saved_replies_updated_by_idx" ON "support_saved_replies" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "support_threads_status_idx" ON "support_threads" USING btree ("status","last_message_at");--> statement-breakpoint
ALTER TABLE "operator_access_log" ADD CONSTRAINT "operator_access_log_action_known" CHECK ("operator_access_log"."action" IN ('inbox.read', 'thread.read', 'thread.reply', 'thread.note', 'thread.status', 'public.read', 'public.note', 'public.status', 'replies.read', 'replies.write'));--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_solved_by" CHECK ("support_threads"."solved_by" IS NULL OR ("support_threads"."status" = 'solved' AND "support_threads"."solved_by" IN ('member', 'pepper', 'auto')));--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_rating" CHECK (("support_threads"."rating" IS NULL) = ("support_threads"."rated_at" IS NULL) AND ("support_threads"."rating" IS NULL OR ("support_threads"."status" = 'solved' AND "support_threads"."rating" IN ('helpful', 'not_helpful'))));--> statement-breakpoint
CREATE POLICY "job_scan" ON "support_messages" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('support'));--> statement-breakpoint
CREATE POLICY "job_scan" ON "support_threads" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('support'));--> statement-breakpoint
CREATE POLICY "operator_access" ON "support_saved_replies" AS PERMISSIVE FOR ALL TO public USING ((SELECT current_operator_id()) IS NOT NULL) WITH CHECK ((SELECT current_operator_id()) IS NOT NULL);--> statement-breakpoint
-- The console, part 2 (S59.2.2, ADR-0062), beyond what drizzle-kit expresses. Saved replies
-- are platform rows only an operator's logged transaction reaches, the owner role included.
ALTER TABLE "support_saved_replies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "support_saved_replies_set_updated_at" BEFORE UPDATE ON "support_saved_replies"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The support job's one write to public requests (AC-X-24/25), which have no business to bind
-- to: "Answered" ones quiet since `p_quiet_before` become solved, and "Open" ones waiting since
-- `p_overdue_before` or earlier, not yet reminded of this wait, are marked reminded. Returns
-- what it changed, for the job's emails. Runs as the owner, whose own policy below is the only
-- way in besides an operator's: the services' role can't read or write these rows otherwise.
CREATE POLICY "support_sweep" ON "public_support_requests" AS PERMISSIVE FOR ALL TO CURRENT_USER
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION support_public_sweep(p_now timestamptz, p_overdue_before timestamptz, p_quiet_before timestamptz)
  RETURNS TABLE (action text, id uuid, reference text, preview text, waiting_since timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_overdue_before > p_now OR p_quiet_before > p_now THEN
    RAISE EXCEPTION 'the sweep looks back, not ahead' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH closed AS (
    UPDATE public_support_requests r
       SET status = 'solved', status_changed_at = p_now
     WHERE r.status = 'answered'
       AND COALESCE(r.status_changed_at, r.created_at) <= p_quiet_before
    RETURNING r.id, r.reference, left(r.body, 140) AS preview, r.created_at
  ), reminded AS (
    UPDATE public_support_requests r
       SET overdue_reminded_at = p_now
     WHERE r.status = 'open'
       AND COALESCE(r.status_changed_at, r.created_at) <= p_overdue_before
       AND (r.overdue_reminded_at IS NULL
            OR r.overdue_reminded_at < COALESCE(r.status_changed_at, r.created_at))
    RETURNING r.id, r.reference, left(r.body, 140) AS preview,
              COALESCE(r.status_changed_at, r.created_at) AS waiting_since
  )
  SELECT 'closed'::text, c.id, c.reference, c.preview, c.created_at FROM closed c
  UNION ALL
  SELECT 'overdue'::text, o.id, o.reference, o.preview, o.waiting_since FROM reminded o;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION support_public_sweep(timestamptz, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_public_sweep(timestamptz, timestamptz, timestamptz) TO pepper_app;
