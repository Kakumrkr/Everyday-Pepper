# ADR-0014: Inviting members with a single-use link

- **Status:** Accepted (user, 2026-10-17; proposed in S9; the user approved a 7-day link, binding to the invitee's email and at most 20 open invites per business at the S9 Session Brief) · **Date:** 2026-10-17 · Builds on ADR-0010 (RLS), ADR-0012 (session tenant context) and ADR-0013 (roles, audit log)

## Context
Until S9, members could only be added by tests and the database. Phase 2 needs owners and managers to bring their team in. Sending email comes in Phase 5, so for now the inviter copies a link and shares it. The invitee is usually not a member of the business yet, and often has no account, so the usual tenant context from the session does not exist when they look at or accept the invite.

## Decision
1. **One invite = one email + one role + one secret link.**
   - **Token:** 32 random bytes (`crypto.randomBytes`), base64url. Only its **SHA-256 hash** is stored (`invites.token_hash`, unique). A fast hash is enough for 256 random bits, and a copy of the table opens nothing.
   - **Lifetime:** 7 days. **Single use:** accepting or revoking sets `accepted_at` or `revoked_at` (never both, CHECK constraint).
   - **Shown once:** `POST /v1/invites` returns the token; nothing returns it again. A lost link is replaced by inviting the same email again, which revokes the earlier invite (audited). The partial unique index `(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` allows one open invite per email per business.
   - **Limit:** at most 20 open (not expired) invites per business, counted under the membership lock.
2. **Bound to the invitee's email.** Accepting requires the signed-in user's email (lowercased) to equal the invite's. A forwarded link gets `403 invite_wrong_account`, and the lookup reveals no business details to the wrong account. Until email verification (Phase 5), this checks the address someone signed up with, not one they proved they own (see Consequences).
3. **Who may invite as what** (`canGrantRole` in core, beside `decideMembershipChange`): it takes `members.invite` (owners and managers). Only owners invite, replace or revoke an invite to become an owner. Like team changes, create and revoke lock the business's memberships and re-read the actor's role in that transaction. Listing invites needs `members.read`, because invites hold emails.
4. **Finding an invite before there is a tenant: a token-keyed RLS policy.** `invites` is a tenant table (forced RLS, `tenant_isolation`) with one more read-only policy, `invite_lookup`: `current_tenant_id() IS NULL AND token_hash = current_invite_token_hash()`. The function reads the transaction-local `app.invite_token_hash`. `withInviteTenant(db, hash, work)` (db):
   1. sets the hash and reads the one matching row;
   2. clears the hash;
   3. binds the transaction to **that row's** `tenant_id`, so the business comes from the database, never from the request;
   4. runs `work`.

   Accepting then locks the business's memberships and the invite row (`FOR UPDATE`) and re-checks it: open, right email, not a member yet. It then adds the membership, marks the invite accepted and writes `invite.accepted`, all in one transaction, so concurrent accepts of one link let exactly one through (tested). The lookup for the preview runs read-only. The isolation suite proves that a hash shows only its own row and no other table, that the policy cannot change anything, that it does not widen a tenant transaction, and that it ends with the transaction.
5. **Audit entries without the email:** `invite.created` (role, expiry), `invite.revoked` (role), `invite.accepted` (role → user id, role, membership id). The actor of an acceptance is the invitee.
6. **Endpoints:**
   - `GET /v1/invites` (`members.read`).
   - `POST /v1/invites` `{ email, role }` (`members.invite`; 201 `{ invite, token }`).
   - `DELETE /v1/invites/:inviteId` (`members.invite`).
   - `POST /v1/invites/lookup` and `POST /v1/invites/accept` `{ token }`: signed in, not tenant-guarded; accepting makes the business the session's active one.
   - The token goes in POST bodies, never in a URL the servers log.
   - New error codes: `invite_invalid` (404, one answer for unknown, used, revoked and expired), `invite_wrong_account` (403), `invite_not_found` (404), `invite_limit_reached` (409), `already_a_member` (409).
7. **The link is `<origin>/invite#<token>`.** Browsers never send the fragment, so the token stays out of request logs and `Referer`. The invite page:
   - reads the token, keeps it in `sessionStorage` for the tab and takes it out of the address bar;
   - when signed out, sends the visitor to sign up or sign in with `?next=/invite`. `safeNext` allows exactly that path, so there is no open redirect.
   - Managers and owners who join go through two-step setup before they can work (ADR-0013).
8. **`permissions` in `GET /v1/tenant`** (`permissionsOf(role)` from the matrix), so the Team screen offers only what the api would allow. The S9 brief said `/v1/me`. `/v1/tenant` is where the role in the active business is known, and the api still checks every action.
9. **The Team screen** (`/team`):
   - owners and managers see the list, role changes, removal, the invite form with the copied link, and the open invites with "Cancel";
   - staff see only "Leave";
   - expiry dates are shown in the business's time zone.

## Consequences
+ A business can grow its team in the app; every step is audited and covered by tests at the db, core, api and browser levels.
+ No server ever logs or stores a working link; a leaked database or log opens no business.
+ The same core services will serve the AI's "invite Jess" tool (Phase 6).
− Until email verification (Phase 5), someone who signs up first with the invitee's address (typed, never proven) could accept an invite that was forwarded to them or leaked. They still need the link itself. Phase 5 makes acceptance require a verified email, and sends the link by email.
− An invite stays valid if its creator is later demoted or removed; the owner can cancel it. If this matters in practice, we can revoke a member's open invites when their role changes.
− The lookup tells "invalid link" apart from "wrong account", but only for someone who already holds the unguessable token.

## Alternatives considered
- **A `SECURITY DEFINER` lookup function**: rejected for the same reason as in ADR-0012. FORCE RLS filters it unless its owner is a superuser, and a policy keeps the rule visible to the isolation suite.
- **A global (non-RLS) invites table**: rejected. Invites hold emails and belong to one business; listing and revoking them must be tenant-isolated like everything else.
- **The token in the query string** (`/invite?token=`): rejected. Query strings reach server and proxy logs and `Referer` headers.
- **Anyone holding the link may join**: rejected by the user in favour of email binding; a forwarded link is useless.
