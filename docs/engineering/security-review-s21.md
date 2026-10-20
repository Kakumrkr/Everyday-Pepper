# Security review: Phase 5 (S19–S21), done in S21

- **Date:** 2026-10-20 · **Scope:** S19 (the transactional outbox, sealed content, the relay and BullMQ delivery, ADR-0024), S20 (reminders, team-booking emails, the clean-up job, the `job_scan` policies, ADR-0025) and S21 (tasks, push devices, the push channel, the due-task job, the service worker's push handlers, ADR-0026).
- **Method:** a read of the code with attention to tenancy and the member scope, what a member can make the worker do, what leaves the system (email, push) and what it carries, secrets and keys, and failure handling. Plus `pnpm audit`.
- **Policy (as in S18):** fix high and medium findings now, each with a test; log low ones for Phase 11.

## Result
No high-severity findings. Two medium findings and one bug were found in the S21 code and fixed before the PR, plus a fail-closed hardening. Five low findings are open for later phases.

| # | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | **SSRF through push devices.** Any member, staff included, could save any `https://` URL as their device, and the worker would POST to it on every booking-page event or due to-do. That could reach internal https services. | **Fixed:** endpoints must be on a browser push service (FCM, Mozilla, Apple, Windows; https, no port or credentials). This is checked when a device is saved (`PushSubscriptionInputSchema`, `isPushServiceEndpoint`) and again in the worker before any request (`PushEndpointNotAllowedError`, given up). Requests also refuse redirects. Tests: contracts "isPushServiceEndpoint", worker "never calls an endpoint that is not a known push service", Playwright "the api refuses a device off the push services". |
| M2 | Medium | **One member could silence the others.** A device lookup was capped at 100 rows across all recipients, oldest first. A staff member who saved 100 devices would push the owner's real device out of every booking-page push, and each push would fan out to all of them. | **Fixed:** each member keeps at most their 10 newest devices (`MAX_DEVICES_PER_MEMBER`), and lookups are sized per recipient. Test: db "keeps each member's newest 10 devices". |
| B1 | Bug | **A shared device could not be turned on by a second member** (a front-desk tablet): the first member's row is hidden from the second by RLS, so the upsert failed (would answer 500). | **Fixed:** the service saves the device as work without a user, always for the authenticated member. Tests: db and core "a shared device moves to whoever turned it on last". |
| H1 | Hardening | `can()` allowed a role missing from the permission matrix (its scope read as `undefined`, not `null`). Roles come from a checked database column, so this was not reachable. | **Fixed:** it fails closed (core "can with a role the matrix does not know"). |
| L1 | Low | **No cap on what a business sends.** An owner can make Pepper email any address (team bookings with "Email the client") and push its own team without limit. The usage meter counts emails but nothing stops them. | Phase 11: per-business daily send quotas from `usage_meters`, with an alert. |
| L2 | Low | **Committed local-only secrets.** Compose and `.env.example` carry `AUTH_SECRET`, `OUTBOX_SECRET` and now a VAPID key pair for development. Nothing stops a deployment from starting with them. | Phase 11 (before the pilot): refuse the known local values when `DEPLOYMENT_ENVIRONMENT=production`. |
| L3 | Low | **Unbounded tasks per business.** A member can add any number of to-dos (200 characters each). | Phase 11 limits, with the other per-business caps. |
| L4 | Low | **A push may arrive twice** if the worker dies after the push service accepted it and before it is marked sent (as for email, ADR-0024). Harmless (the same tag replaces it on most devices). | Accepted; revisit with a provider. |
| L5 | Low | **`pnpm audit`** (dev tooling only, as in S18): `braces` (lint toolchain, no patch exists) and `esbuild` (drizzle-kit). `pnpm audit --prod`: no known vulnerabilities, `web-push` 3.6.7 included. | Re-check when patches ship. |

The S18 findings L1–L6 and L8 stay open as recorded there; L7 (expired booking requests) was fixed in S20.

## Checked and fine
- **Tenancy:**
  - `tasks` and `push_subscriptions` are in the cross-tenant isolation suite, with their `member_scope` policies, the `tasks` job scan and its read-only, ids-only reach.
  - The worker handles each due task and each message under its business's tenant.
  - The outbox scan and the reminder and clean-up scans are read-only and see ids only (S19, S20).
- **Staff scope:** staff reach only tasks assigned to them or that they created, in the service and in RLS (`WITH CHECK` too, so a staff member cannot hand a task away out of sight). Staff assign only themselves. Proven at the db, service, api and Playwright levels.
- **What leaves the system:**
  - Pushes carry a service, a staff member's name, a time and an app path, never a client's name or contact. Due to-dos carry the member's own title, to the assignee (or the owners and managers).
  - Push content is sealed in the outbox (AES-256-GCM, key from `OUTBOX_SECRET`, bound to the message id) and encrypted to the device by Web Push.
  - Emails are plain text with folded subjects (S17–S20).
- **The service worker** opens only pages of the app's own origin from a push, whatever its data says (tests for `//host`, `/\host` and full URLs). The outbox also refuses any `url` that is not an app path.
- **Secrets:**
  - The api holds only the VAPID public key; the private key is only in the worker.
  - Errors and logs carry error names and ids, never endpoints, addresses or content.
  - `OUTBOX_SECRET` is separate from `AUTH_SECRET` (the worker does not need the auth secret).
- **CSRF:** the new writes (`/v1/tasks`, `/v1/push/subscription`) need the app's `Origin` like every other. The device endpoint travels in bodies, never in URLs.
- **Failure handling:**
  - Gone devices are removed without alerts.
  - Refusals for good (our keys, a bad request) give up with an alert.
  - Busy push services and a missing channel retry.
