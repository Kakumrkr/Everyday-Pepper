CREATE TYPE "public"."outbox_message_type" AS ENUM('email');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'dead');--> statement-breakpoint
CREATE TABLE "outbox_dispatch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"available_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_dispatch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"type" "outbox_message_type" NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" "bytea",
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "outbox_messages_dedupe_key_unique" UNIQUE("tenant_id","dedupe_key"),
	CONSTRAINT "outbox_messages_dedupe_key_format" CHECK ("outbox_messages"."dedupe_key" ~ '^[A-Za-z0-9.:_-]{1,200}$'),
	CONSTRAINT "outbox_messages_attempts_range" CHECK ("outbox_messages"."attempts" BETWEEN 0 AND 100),
	CONSTRAINT "outbox_messages_last_error_format" CHECK ("outbox_messages"."last_error" ~ '^[A-Za-z0-9.:_-]{1,100}$'),
	CONSTRAINT "outbox_messages_payload_while_pending" CHECK (("outbox_messages"."status" = 'pending') = ("outbox_messages"."payload" IS NOT NULL)),
	CONSTRAINT "outbox_messages_sent_at_when_sent" CHECK (("outbox_messages"."status" = 'sent') = ("outbox_messages"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "outbox_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_dispatch" ADD CONSTRAINT "outbox_dispatch_message_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."outbox_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_dispatch_available_at_idx" ON "outbox_dispatch" USING btree ("available_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox_dispatch" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "outbox_scan" ON "outbox_dispatch" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND current_outbox_scan());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox_messages" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());