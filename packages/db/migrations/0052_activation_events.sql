CREATE TABLE "activation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_events_tenant_kind_unique" UNIQUE("tenant_id","kind"),
	CONSTRAINT "activation_events_kind_known" CHECK ("activation_events"."kind" IN ('business_created', 'bookable', 'first_booking')),
	CONSTRAINT "activation_events_account_on_creation" CHECK ("activation_events"."kind" = 'business_created' OR "activation_events"."account_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "activation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signup_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_events_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "activation_events" ADD CONSTRAINT "activation_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_events" ADD CONSTRAINT "activation_events_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_events" ADD CONSTRAINT "signup_events_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activation_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Hardening (S45, ADR-0046), beyond what drizzle-kit expresses. RLS applies to the table owner
-- too (as for every tenant-owned table, ADR-0010); both tables are append-only for the services
-- (a business's or account's deletion removes its rows through the foreign keys).
ALTER TABLE "activation_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "activation_events" FROM pepper_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "signup_events" FROM pepper_app;
