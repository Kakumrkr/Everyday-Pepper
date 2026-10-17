# Security & Tenancy

Target: OWASP ASVS Level 2.

## Threat model (top threats → controls)
| Threat | Control |
|---|---|
| Cross-tenant data access | `tenant_id` + Postgres RLS on every tenant table; app DB role without `BYPASSRLS`; tenant set via `SET LOCAL app.tenant_id` per transaction from the authenticated session; cross-tenant test suite in CI (100% required); roles and the tenant helper: ADR-0010. References between tenant tables are composite foreign keys on `(tenant_id, id)`, because foreign key checks bypass RLS ([ADR-0015](../adr/0015-appointments-base-data.md)). The tenant of a request comes only from the session's `active_tenant_id`, set after a membership check; `TenantGuard` re-checks membership on every request (ADR-0012) |
| Privilege escalation within tenant | RBAC (owner/manager/staff) + resource scoping enforced in domain services (shared by UI and AI); role-matrix tests. Built in S8 ([ADR-0013](../adr/0013-roles-audit-log-and-metering.md)): `PERMISSION_MATRIX` + `can()` in core (staff reach only their own bookings, clients and notes), `@RequirePermission` on routes, membership rules (only owners touch owners; one owner always remains) applied under a lock with the actor's role re-read in the transaction; staff cannot probe membership (403 before lookup). S10 (ADR-0015): staff manage only the time off of the staff member linked to their own login, and cannot change working hours, staff or services. S11 (ADR-0016): booking rules are read by everyone and changed only by owners and managers (`rules.manage`); a rule may name only the business's own staff members. S12 (ADR-0017): **staff-scoped RLS** — member requests run in `withMember` (tenant + user); restrictive `member_scope*` policies limit staff to their own staff member's bookings and waitlist entries, and to reading the clients of those (no client writes); everyone reads busy times (`booking_occupancy`, no details); only owners and managers may override hours and rules, never an overlap. **Still to do:** notes (Phase 7) |
| Prompt injection (notes, imported data, websites, calendar text) | Untrusted content wrapped/labelled; tools cannot change tenant or permissions; external/irreversible actions gated by autonomy rules; bulk sends never fully automatic; evals include injection cases |
| AI performing unintended actions | Risk tiers, autonomy dial, proposals, undo, audit log, eval gate |
| Account takeover | Better Auth (ADR-0007/0012): TOTP + backup codes, **required for owners and managers** before they can open their business (403 `mfa_required`; managers since S8, ADR-0013); HttpOnly SameSite=Lax cookies (Secure + `__Secure-` on https); passwords ≥ 10 characters, hashed (scrypt); rate limits on sign-in, sign-up and second-factor checks, plus two-factor account lockout; generic "email and password don't match". **Still to do:** breached-password check and an edge proxy that overwrites `X-Forwarded-For` (Phase 11), Redis-backed limits for several instances, email verification and password reset (Phase 5) |
| Invite link misuse (forwarding, leaks, escalation) | [ADR-0014](../adr/0014-invites.md): 256-bit random token, only its SHA-256 hash stored; in the link's fragment and POST bodies, never in logged URLs; single use, 7 days, revocable; bound to the invitee's email (403 for any other account, no business details shown); only owners invite owners, actor's role re-read under the membership lock; lookup through a read-only token-keyed RLS policy, the business taken from the invite row. **Still to do:** require a verified email to accept (Phase 5) |
| Booking page abuse (spam, enumeration) | Email verification codes (hashed, expiring, attempt-limited), rate limits, bot protection (e.g. Turnstile), signed booking-scoped links |
| Repudiation / untraceable changes | Append-only `audit_log` written in the same transaction as each change (actor, action, entity, before/after allowlisted per action, request id); the services cannot update or delete it; readable by owners and managers (`GET /v1/audit-log`) |
| Resource abuse by one account | At most 5 businesses per owner, enforced in the creating transaction under a per-user lock (S8) |
| Secrets leakage | Secrets in env/secret manager only; never in repo or logs; secret scanning in CI; OAuth tokens envelope-encrypted |
| Webhook spoofing | Signature verification (Google channel tokens, email provider signatures) |
| Supply-chain | Lockfile, Dependabot/Renovate, `pnpm audit` in CI, pinned base images |
| Data loss | Backups + PITR (pilot: nightly encrypted dumps + WAL if feasible), quarterly restore drill |

## Privacy
- PII minimisation in LLM prompts; redacting logger; no PII in analytics events.
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

CSP and HSTS headers are Phase 11.

## Security process
Security review checklist on every PR touching auth, tenancy, AI tools, integrations, or file handling; `/security-review` before each phase exit; dependency and secret scanning in CI; pre-pilot external review if budget allows.
