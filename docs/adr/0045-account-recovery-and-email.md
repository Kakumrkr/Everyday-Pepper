# ADR-0045: Account recovery, email confirmation and change of email

- **Status:** Accepted. Approved by the user at the S44 brief on 2026-10-28 ("D1 is B. Rest all, go with your recommendation. and complete the session").
- **Date:** 2026-10-28
- **Builds on:**
  - ADR-0007 (Better Auth), ADR-0012 (sessions and tenant context; its "sign-up reveals whether an email is registered" gap)
  - ADR-0024 (the transactional outbox and email delivery)
  - [V1 playbook](../plan/v1-playbook.md) Phase 10, S44; PCR-007 (existing accounts are not forced to verify)

## Context
Until S44 a forgotten password meant writing to support, addresses were never checked, and an email could not be changed. The playbook asks for password reset, email verification (`requireEmailVerification` for new accounts) and change of email, "through the outbox".

The outbox (ADR-0024) is per business: `outbox_messages.tenant_id` is required, points to a tenant, and its dedupe key is per tenant. An account's emails belong to a user who may have no business yet (a new sign-up), and the person is waiting on the screen for the link.

## Decision
1. **Sent at once through `MAILER`, not the outbox (D-2).** Better Auth's callbacks build the email (`apps/api/src/auth/auth-emails.ts`) and send it in the request, as the booking page's codes already are (ADR-0022). A failed send never fails the request (that would tell an address with an account from one without): it is logged without the address, and the person asks again ("Send the link again", "Forgot your password?"). No migration, RLS or dedupe change to the outbox.
2. **Password reset.** `POST /api/auth/request-password-reset` answers the same for any address. The link works once (Better Auth stores the token in `verifications` and deletes it on use) for 60 minutes; a new password revokes every session (`revokeSessionsOnPasswordReset`). The request log replaces the token in `/api/auth/reset-password/<token>` with `:token`.
3. **Email confirmation for new accounts.** `requireEmailVerification: true`, sent on sign-up and again on an unconfirmed sign-in; the link (24 hours) signs in and goes on through `/email-confirmed` to `next` (the invite) or home. It also makes sign-up answer the same for a taken address (closing ADR-0012's gap); that address's owner gets "You already have a Pepper account" instead.
4. **Existing accounts (D-3).** Migration `0051_existing_accounts_verified` marks every account made before S44 confirmed, so Better Auth's own check stays the only gate and nobody is locked out.
5. **Change of email.** From More → "Change email" (`/account/email`). The new address gets a link and nothing changes until it is opened; the old address is told at the same time (with the new address and "Forgot your password?"). An address that already has an account gets the same answer and no link. `updateEmailWithoutVerification` stays off.
6. **Rate limits.** The three endpoints that send email allow 3 a minute per client address (`EMAIL_RATE_LIMITS`), on top of Better Auth's stricter sign-in and sign-up rules; still in memory until Redis-backed limits (S58).
7. **Screens on `AuthPage` (S43.2's frame):** forgot password and its "Check your inbox", a new password, a run-out link, "Check your inbox" after sign-up with "Send the link again" (waits 30 s between sends), "Your email is changed", change email. Each field shows its own error under it; the main action sits in the sticky bar at the bottom of the phone.

## Consequences
- An invited staff member confirms their email before joining (one more tap); the link brings them back to the invite.
- A stolen signed-in session could start a change of email; the old address is told before anything changes and can reset the password. Asking for the password (or a second factor) before a change is a later hardening, logged for the S60 security review.
- Account emails don't survive an SMTP outage the way outbox mail does; the screens offer "send again".
- Email confirmation links are Better Auth's signed tokens (not stored): opening one twice is harmless (already confirmed).

## Tests
`apps/api/src/auth.int.test.ts` "account recovery and email" (no oracle on reset, resend or a taken sign-up; reset once and every session out; change only after the new address confirms; nothing in the logs), `better-auth.test.ts`, `auth-emails.test.ts`, `packages/db/src/migrate.int.test.ts` (0051), `packages/runtime/src/request-logging.test.ts`, `e2e/tests/auth.spec.ts` "account recovery and email", `e2e/tests/screens.spec.ts` (baselines, tap targets, `expectStickyAtTheBottom`).
