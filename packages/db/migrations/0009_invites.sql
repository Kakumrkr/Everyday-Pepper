CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_email_lowercase" CHECK ("invites"."email" = lower("invites"."email")),
	CONSTRAINT "invites_token_hash_format" CHECK ("invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_accepted_or_revoked" CHECK ("invites"."accepted_at" IS NULL OR "invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_open_email_unique" ON "invites" USING btree ("tenant_id","email") WHERE "invites"."accepted_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "invites_invited_by_user_id_idx" ON "invites" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "invites_accepted_by_user_id_idx" ON "invites" USING btree ("accepted_by_user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invites" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "invite_lookup" ON "invites" AS PERMISSIVE FOR SELECT TO public USING (current_tenant_id() IS NULL AND token_hash = current_invite_token_hash());