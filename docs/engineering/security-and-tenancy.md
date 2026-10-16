# Security & Tenancy

Target: OWASP ASVS Level 2.

## Threat model (top threats → controls)
| Threat | Control |
|---|---|
| Cross-tenant data access | `tenant_id` + Postgres RLS on every tenant table; app DB role without `BYPASSRLS`; tenant set via `SET LOCAL app.tenant_id` per transaction from the authenticated session; cross-tenant test suite in CI (100% required); roles and the tenant helper: ADR-0010 |
| Privilege escalation within tenant | RBAC (owner/manager/staff) + resource scoping enforced in domain services (shared by UI and AI); role-matrix tests |
| Prompt injection (notes, imported data, websites, calendar text) | Untrusted content wrapped/labelled; tools cannot change tenant or permissions; external/irreversible actions gated by autonomy rules; bulk sends never fully automatic; evals include injection cases |
| AI performing unintended actions | Risk tiers, autonomy dial, proposals, undo, audit log, eval gate |
| Account takeover | Managed/self-hosted auth with MFA for owners, secure session cookies (HttpOnly, SameSite), rate-limited login, breached-password check |
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

## Security process
Security review checklist on every PR touching auth, tenancy, AI tools, integrations, or file handling; `/security-review` before each phase exit; dependency and secret scanning in CI; pre-pilot external review if budget allows.
