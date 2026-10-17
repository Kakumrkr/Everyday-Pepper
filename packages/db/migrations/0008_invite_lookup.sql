-- The invite token hash of the current transaction, set by `withInviteTenant` with
-- set_config(..., true) while an invitee who is not a member yet looks up their invite
-- (ADR-0014). NULL when unset, like current_tenant_id(). Used only by the read-only
-- invite_lookup policy on invites (migration 0009), which also requires that no tenant is set.
CREATE FUNCTION current_invite_token_hash() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.invite_token_hash', true), '') $$;
