ALTER TABLE "tenants" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "public_address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cancellation_policy" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_phone_format" CHECK ("tenants"."phone" ~ '^\+[1-9][0-9]{6,14}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_public_address_length" CHECK (length("tenants"."public_address") BETWEEN 5 AND 300);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_cancellation_policy_length" CHECK (length("tenants"."cancellation_policy") BETWEEN 1 AND 600);