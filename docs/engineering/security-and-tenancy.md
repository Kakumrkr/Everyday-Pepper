# Security & Tenancy

Target: OWASP ASVS Level 2.

## Threat model (top threats → controls)
| Threat | Control |
|---|---|
| Cross-tenant data access | `tenant_id` + Postgres RLS on every tenant table; app DB role without `BYPASSRLS`; tenant set via `SET LOCAL app.tenant_id` per transaction from the authenticated session; cross-tenant test suite in CI (100% required); roles and the tenant helper: ADR-0010. References between tenant tables are composite foreign keys on `(tenant_id, id)`, because foreign key checks bypass RLS ([ADR-0015](../adr/0015-appointments-base-data.md)). The tenant of a request comes only from the session's `active_tenant_id`, set after a membership check; `TenantGuard` re-checks membership on every request (ADR-0012) |
| Privilege escalation within tenant | RBAC (owner/manager/staff) + resource scoping enforced in domain services (shared by UI and AI); role-matrix tests. Built in S8 ([ADR-0013](../adr/0013-roles-audit-log-and-metering.md)): `PERMISSION_MATRIX` + `can()` in core (staff reach only their own bookings, clients and notes), `@RequirePermission` on routes, membership rules (only owners touch owners; one owner always remains) applied under a lock with the actor's role re-read in the transaction; staff cannot probe membership (403 before lookup). S10 (ADR-0015): staff manage only the time off of the staff member linked to their own login, and cannot change working hours, staff or services. S11 (ADR-0016): booking rules are read by everyone and changed only by owners and managers (`rules.manage`); a rule may name only the business's own staff members. S12 (ADR-0017): **staff-scoped RLS** — member requests run in `withMember` (tenant + user); restrictive `member_scope*` policies limit staff to their own staff member's bookings and waitlist entries, and to reading the clients of those (no client writes); everyone reads busy times (`booking_occupancy`, no details); only owners and managers may override hours and rules, never an overlap. S13 (Phase 3 exit security review): restrictive `member_scope_*` write policies on `staff_members` and `memberships`, so inside `withMember` only owners and managers change staff links and roles (a member may still delete their own membership, i.e. leave); staff cannot widen their own RLS scope even if a service check is missed. **Still to do:** notes (Phase 7) |
| Prompt injection (notes, imported data, websites, calendar text) | Untrusted content wrapped/labelled; tools cannot change tenant or permissions; external/irreversible actions gated by autonomy rules; bulk sends never fully automatic; evals include injection cases |
| AI performing unintended actions | Risk tiers, autonomy dial, proposals, undo, audit log, eval gate |
| Account takeover | Better Auth (ADR-0007/0012): TOTP + backup codes, **required for owners and managers** before they can open their business (403 `mfa_required`; managers since S8, ADR-0013); HttpOnly SameSite=Lax cookies (Secure + `__Secure-` on https); passwords ≥ 10 characters, hashed (scrypt); rate limits on sign-in, sign-up and second-factor checks, plus two-factor account lockout; generic "email and password don't match". **Still to do:** breached-password check and an edge proxy that overwrites `X-Forwarded-For` (Phase 11), Redis-backed limits for several instances, email verification and password reset (Phase 5) |
| Invite link misuse (forwarding, leaks, escalation) | [ADR-0014](../adr/0014-invites.md): 256-bit random token, only its SHA-256 hash stored; in the link's fragment and POST bodies, never in logged URLs; single use, 7 days, revocable; bound to the invitee's email (403 for any other account, no business details shown); only owners invite owners, actor's role re-read under the membership lock; lookup through a read-only token-keyed RLS policy, the business taken from the invite row. **Still to do:** require a verified email to accept (Phase 5) |
| Booking page abuse (spam, enumeration) | [ADR-0022](../adr/0022-public-booking-page.md) (S17): nothing booked before the emailed code; codes HMAC-hashed under a key derived from `AUTH_SECRET`, 10 minutes, 5 attempts; 5 requests per email per business per hour; Redis rate limits per address and 100 code emails per business per hour, failing closed; reschedule/cancel link token of 256 bits, only its SHA-256 stored, in the URL fragment and POST bodies only, valid only under its own business; members never reach booking requests (RLS); the slug lookup is a read-only policy that shows one tenant row and nothing else; a malformed slug answers like an unknown one. **Still to do:** bot protection (Turnstile) and the edge proxy that makes per-address limits trustworthy (Phase 11), cleanup of expired requests (Phase 5) |
| Repudiation / untraceable changes | Append-only `audit_log` written in the same transaction as each change (actor, action, entity, before/after allowlisted per action, request id); the services cannot update or delete it; readable by owners and managers (`GET /v1/audit-log`) |
| Resource abuse by one account | At most 5 businesses per owner, enforced in the creating transaction under a per-user lock (S8) |
| Secrets leakage | Secrets in env/secret manager only; never in repo or logs; secret scanning in CI; OAuth tokens envelope-encrypted |
| Webhook spoofing | Signature verification (Google channel tokens, email provider signatures) |
| Supply-chain | Lockfile, Dependabot/Renovate, `pnpm audit` in CI, pinned base images |
| Data loss | Backups + PITR (pilot: nightly encrypted dumps + WAL if feasible), quarterly restore drill |

## Privacy
- PII minimisation in LLM prompts; redacting logger; no PII in analytics events. The redacting logger (also used for Sentry) drops failed queries' bound values (`params`), Postgres's row `detail`, emails and phone numbers (North American formats and any E.164), S13.
- OpenAI API data not used for training; evaluate zero-data-retention eligibility before pilot.
- CCPA-aware: customer data export and deletion per tenant; business account export/delete.
- Email: CAN-SPAM compliant footers and opt-out. SMS (V1.1): TCPA consent records, A2P 10DLC.
- Terms of Service, Privacy Policy, DPA template, AI-use disclosure — required before pilot (needs company entity).

## Web security
CSP, HSTS, CSRF protection for cookie auth, input validation with Zod, output encoding, file upload type/size checks and private storage, CORS restricted to known origins.

Built in S7 (ADR-0012):
- **One origin.** The web app forwards `/api/auth/*` and `/v1/*` to the api, with allowlisted headers and bodies capped at 100 KB. No CORS is needed.
- **CSRF.** Every non-GET api request must carry `Origin` = `AUTH_BASE_URL` (`SameOriginGuard`). Better Auth checks the same on its endpoints, pinned on in every environment.
- **Errors.** `{ code, message }` bodies name invalid fields but never echo their values.

Added in S18 ([ADR-0023](../adr/0023-pwa-offline-and-phase-4-exit.md), [security review](security-review-s18.md)):
- **Headers on every web response:** CSP `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
- **No storing of api answers:** forwarded answers get `Cache-Control: private, no-store` unless the api sets its own.
- **Service worker:** caches only the static offline page, never pages or api answers.

A script-restricting CSP (nonces) and HSTS are Phase 11.

## Security process
Security review checklist on every PR touching auth, tenancy, AI tools, integrations, or file handling; `/security-review` before each phase exit; dependency and secret scanning in CI; pre-pilot external review if budget allows.
