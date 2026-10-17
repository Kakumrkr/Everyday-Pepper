# Security & Tenancy

Target: OWASP ASVS Level 2.

## Threat model (top threats → controls)
| Threat | Control |
|---|---|
| Cross-tenant data access | `tenant_id` + Postgres RLS on every tenant table; app DB role without `BYPASSRLS`; tenant set via `SET LOCAL app.tenant_id` per transaction from the authenticated session; cross-tenant test suite in CI (100% required); roles and the tenant helper: ADR-0010. The tenant of a request comes only from the session's `active_tenant_id`, set after a membership check; `TenantGuard` re-checks membership on every request (ADR-0012) |
| Privilege escalation within tenant | RBAC (owner/manager/staff) + resource scoping enforced in domain services (shared by UI and AI); role-matrix tests |
| Prompt injection (notes, imported data, websites, calendar text) | Untrusted content wrapped/labelled; tools cannot change tenant or permissions; external/irreversible actions gated by autonomy rules; bulk sends never fully automatic; evals include injection cases |
| AI performing unintended actions | Risk tiers, autonomy dial, proposals, undo, audit log, eval gate |
| Account takeover | Better Auth (ADR-0007/0012): TOTP + backup codes, **required for owners** before they can open their business (403 `mfa_required`); HttpOnly SameSite=Lax cookies (Secure + `__Secure-` on https); passwords ≥ 10 characters, hashed (scrypt); rate limits on sign-in, sign-up and second-factor checks, plus two-factor account lockout; generic "email and password don't match". **Still to do:** breached-password check and an edge proxy that overwrites `X-Forwarded-For` (Phase 11), Redis-backed limits for several instances, email verification and password reset (Phase 5) |
| Booking page abuse (spam, enumeration) | Email verification codes (hashed, expiring, attempt-limited), rate limits, bot protection (e.g. Turnstile), signed booking-scoped links |
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
