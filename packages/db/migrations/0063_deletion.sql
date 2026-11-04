ALTER TABLE "tenants" ADD COLUMN "deletion_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_due_at" timestamp with time zone;--> statement-breakpoint
-- Deletion with a grace period (S51.2, ADR-0054): a business or an account is deleted for good
-- once its `deletion_due_at` has passed (30 days after it was asked for; NULL: not being
-- deleted). The worker finds the due ones by these indexes.
CREATE INDEX "tenants_deletion_due_idx" ON "tenants" ("deletion_due_at") WHERE "deletion_due_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "users_deletion_due_idx" ON "users" ("deletion_due_at") WHERE "deletion_due_at" IS NOT NULL;
--> statement-breakpoint
-- Deleting a business takes every one of its rows with it (each tenant table cascades from
-- `tenants`, as the table owner), so the services may delete one only when its day has come:
-- an owner's request can never become an immediate deletion, whatever the code above does.
CREATE FUNCTION tenants_deletion_due() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  -- The services' roles only: a superuser (operations by hand, tests) is a member of every
  -- role, so it is named out; the migration role is not a member of pepper_app.
  IF pg_has_role(current_user, 'pepper_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND (OLD.deletion_due_at IS NULL OR OLD.deletion_due_at > now()) THEN
    RAISE EXCEPTION 'this business is not due for deletion' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenants_deletion_due" BEFORE DELETE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION tenants_deletion_due();
