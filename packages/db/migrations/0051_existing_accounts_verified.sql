-- S44 (ADR-0045): new accounts confirm their email before signing in. Accounts made before
-- then were never asked to, so they count as confirmed and keep signing in as before (PCR-007).
UPDATE "users" SET "email_verified" = true, "updated_at" = now() WHERE "email_verified" = false;
