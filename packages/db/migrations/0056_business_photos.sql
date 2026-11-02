CREATE TABLE "business_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"kind" text NOT NULL,
	"widths" integer[] NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_photos_kind_known" CHECK (kind IN ('logo', 'cover', 'gallery')),
	CONSTRAINT "business_photos_widths_valid" CHECK (cardinality("business_photos"."widths") BETWEEN 1 AND 3 AND 0 < ALL("business_photos"."widths") AND 1920 >= ALL("business_photos"."widths")),
	CONSTRAINT "business_photos_size_positive" CHECK ("business_photos"."width" > 0 AND "business_photos"."height" > 0),
	CONSTRAINT "business_photos_caption_length" CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 150)
);
--> statement-breakpoint
ALTER TABLE "business_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_photos" ADD CONSTRAINT "business_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_photos_one_per_kind" ON "business_photos" USING btree ("tenant_id","kind") WHERE "business_photos"."kind" <> 'gallery';--> statement-breakpoint
CREATE INDEX "business_photos_created_idx" ON "business_photos" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "business_photos" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
-- Hardening (S47.2, ADR-0048), beyond what drizzle-kit expresses: RLS applies to the table
-- owner too, as for every tenant-owned table (ADR-0010).
ALTER TABLE "business_photos" FORCE ROW LEVEL SECURITY;
