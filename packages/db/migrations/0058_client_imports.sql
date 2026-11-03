CREATE TABLE "client_import_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_import_refs_system_id_unique" UNIQUE("tenant_id","system","external_id"),
	CONSTRAINT "client_import_refs_system_format" CHECK ("client_import_refs"."system" ~ '^[a-z0-9:]{1,64}$'),
	CONSTRAINT "client_import_refs_external_id_length" CHECK (length("client_import_refs"."external_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "client_import_refs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"created_by_user_id" uuid,
	"status" text DEFAULT 'staged' NOT NULL,
	"format" text NOT NULL,
	"preset" text,
	"system" text NOT NULL,
	"columns" jsonb NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"undo" jsonb,
	"committed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_batches_status_known" CHECK ("import_batches"."status" IN ('staged', 'queued', 'running', 'done', 'failed', 'undone')),
	CONSTRAINT "import_batches_format_known" CHECK ("import_batches"."format" IN ('csv', 'json', 'jsonl')),
	CONSTRAINT "import_batches_preset_known" CHECK ("import_batches"."preset" IS NULL OR "import_batches"."preset" IN ('square', 'booksy', 'vagaro', 'glossgenius', 'fresha')),
	CONSTRAINT "import_batches_system_format" CHECK ("import_batches"."system" ~ '^[a-z0-9:]{1,64}$'),
	CONSTRAINT "import_batches_committed" CHECK ("import_batches"."status" = 'staged' OR "import_batches"."committed_at" IS NOT NULL),
	CONSTRAINT "import_batches_finished" CHECK ("import_batches"."status" NOT IN ('done', 'failed', 'undone') OR ("import_batches"."finished_at" IS NOT NULL AND "import_batches"."undo_until" IS NOT NULL)),
	CONSTRAINT "import_batches_undone" CHECK (("import_batches"."status" = 'undone') = ("import_batches"."undone_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"row" integer NOT NULL,
	"cells" jsonb,
	"name" text,
	"email" text,
	"phone" text,
	"external_id" text,
	"row_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_id" uuid,
	"fills" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "import_rows_batch_position_unique" UNIQUE("batch_id","position"),
	CONSTRAINT "import_rows_outcome_known" CHECK ("import_rows"."outcome" IN ('create', 'merge', 'unchanged', 'invalid', 'skipped')),
	CONSTRAINT "import_rows_position" CHECK ("import_rows"."position" >= 0 AND "import_rows"."row" > 0)
);
--> statement-breakpoint
ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_import_refs" ADD CONSTRAINT "client_import_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_refs" ADD CONSTRAINT "client_import_refs_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."import_batches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_import_refs_client_idx" ON "client_import_refs" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "import_batches_due_idx" ON "import_batches" USING btree ("available_at") WHERE "import_batches"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "import_batches_tenant_created_idx" ON "import_batches" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "import_rows_tenant_hash_idx" ON "import_rows" USING btree ("tenant_id","row_hash");--> statement-breakpoint
CREATE INDEX "import_rows_tenant_client_idx" ON "import_rows" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_import_refs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "client_import_refs" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all())) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_batches" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "import_batches" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all())) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
CREATE POLICY "job_scan" ON "import_batches" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_job_scan('imports'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_rows" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "member_scope" ON "import_rows" AS RESTRICTIVE FOR ALL TO public USING ((SELECT current_member_sees_all())) WITH CHECK ((SELECT current_member_sees_all()));--> statement-breakpoint
-- Hardening (S48, ADR-0049), beyond what drizzle-kit expresses: RLS applies to the table owner
-- too, as for every tenant-owned table (ADR-0010).
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client_import_refs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "import_batches_set_updated_at" BEFORE UPDATE ON "import_batches"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
