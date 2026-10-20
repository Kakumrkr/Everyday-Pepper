# Security review: Phase 4 (S14–S17), done in S18

- **Date:** 2026-10-20 · **Scope:** everything merged in S14–S17 (PRs #17–#21): the design system and app shell, booking screens and exact-contact client lookup (ADR-0020), setup screens (ADR-0021), and the public booking page with emailed codes, link tokens, the SMTP mailer and Redis rate limits (ADR-0022). Also the new S18 code (service worker, headers).
- **Method:** a read of the diff with attention to tenancy, auth, CSRF and the anonymous endpoints. Checks on the running stack: response headers of web and api, forwarding rules, rate-limit keys, and which caches the browser may keep. Plus `pnpm audit`.
- **Policy (user, S18 brief):** fix high and medium findings now, each with a test; log low ones here for Phase 11.

## Result
No high-severity findings. Two medium findings were fixed in S18. Seven low findings are open for later phases; none blocks the Phase 4 exit.

| # | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | **Clickjacking.** No page sent `frame-ancestors` or `X-Frame-Options`, so any site could frame the app or the booking link page and trick a signed-in owner (or a client) into "Cancel booking", "Remove member" and the like. | **Fixed:** CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY`, plus `nosniff`, `Referrer-Policy`, `Permissions-Policy` on every response (`apps/web/lib/security-headers.ts`, `next.config.ts`; tests `apps/web/lib/pwa.test.ts` "response headers"). |
| M2 | Medium | **Personal data in the browser's disk cache.** Answers forwarded from `/v1` and `/api/auth` carried no `Cache-Control`, so a shared front-desk tablet could keep client names, emails and phones in its HTTP cache after sign-out. | **Fixed:** the forwarder sets `private, no-store` unless the api says otherwise (`apps/web/lib/forward.ts`; test "marks answers private and not to be stored…"). The new service worker caches only the offline page (ADR-0023). |
| L1 | Low | **Per-address limits trust `X-Forwarded-For`.** A script that sends its own header chooses its address, so the per-address limits on the booking page can be spread. Per-business and per-email limits still hold, and so do the 5 attempts per code. | Known (ADR-0022). Phase 11: an edge proxy overwrites the header; Turnstile. |
| L2 | Low | **Rate-limit keys of any length.** The key is the caller-chosen address, so each request can create a Redis key of up to a header's size (expiring with its window). | Phase 11 with L1: cap or hash the key. |
| L3 | Low | **The manage link stays in the address bar and history.** `/book/<slug>/manage#<token>` keeps the token in the URL after the page reads it. Someone using the same browser later could reschedule or cancel. The invite page already clears its token. | Later: read the token, then `history.replaceState`, keeping it for the visit only. |
| L4 | Low | **No script-restricting CSP.** XSS defences are React's escaping and no `dangerouslySetInnerHTML` (none found); a `script-src` CSP needs nonces with Next.js. | Phase 11 with HSTS (security-and-tenancy.md). |
| L5 | Low | **Staff client lookup is not throttled.** A signed-in staff member can try many exact emails or phones (ADR-0020 §Consequences). | Phase 11 hardening. |
| L6 | Low | **Code emails carry caller-typed text.** The name typed on the booking page appears in the code email to any address, a small spam or phishing channel, bounded by 5 per email address per business per hour and 100 per business per hour. | Phase 11: Turnstile; consider leaving the name out of the code email. |
| L7 | Low | **Expired booking requests are kept.** `booking_verifications` rows (name, email, phone, code hash) are never deleted. | Planned: the Phase 5 cleanup job (STATUS S17 "for later"). |
| L8 | Low | **`pnpm audit`:** `braces` ≤ 3.0.3 (GHSA-vfj7-8cjw-p6xm, rated high, **no patched version exists**) only in the lint toolchain (`@next/eslint-plugin-next` → `fast-glob`); `esbuild` ≤ 0.24.2 (moderate) only in `drizzle-kit`'s loader. Neither is in a running service (`pnpm audit --prod`: no known vulnerabilities); braces needs attacker-chosen glob patterns, and only our own config supplies them. | Low in context. Re-check when a patch ships. |

## Checked and fine
- **Tenancy:** the public endpoints take the business from the URL slug only (`withPublicTenant`). A link token or request id of another business is "not found". `booking_verifications` is out of every member's reach (restrictive `member_scope`). Staff see clients only by an exact contact, read-only.
- **CSRF:** every non-GET api request needs `Origin` = the app (`SameOriginGuard`), the public endpoints included.
- **Codes and tokens:** codes are HMAC-SHA256 under an HKDF key from `AUTH_SECRET` and compared in constant time. Attempts are counted under a row lock and committed before the 422. Link tokens are 256-bit, stored as SHA-256 and sent in POST bodies, never in a query string.
- **Email:** plain text; subjects are folded to one line (no header injection); failures are logged without address or content.
- **Redirects:** `next` after sign-in or sign-up is an allowlist (`safeNext`).
- **Forwarding:** allowlisted request and response headers, 100 KB bodies, no `authorization` passed. Paths outside `/v1` and `/api/auth` only reach the api's health checks.
- **Brand color:** `#rrggbb` only (schema and database check) before it reaches a `style`.
- **Logs:** no personal data in the new log lines.
