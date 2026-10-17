# Traceability Matrix

Links each requirement to its design and tests. Test columns are filled in as phases are built; an empty test cell at phase exit is a blocker.

| Requirement | Design | Phase | Tests |
|---|---|---|---|
| AC-W1-1/2 onboarding draft & confirm | jobs-messaging-integrations (extraction), modules-and-templates | 9 | _tbd_ |
| AC-W1-3 CSV import idempotent | jobs-messaging-integrations | 9 | _tbd_ |
| AC-W2-1 conflict → alternatives | modules-and-templates (availability), ai-agent | 3, 6 | Engine: `packages/modules/appointments/src/availability/engine.test.ts` "works around an existing booking (AC-W2-1…)" and the property tests in `engine.property.test.ts` (S11); conflict explanation and the 3 nearest slots as a card: _tbd_ (Phase 6) |
| AC-W2-2 autonomy "ask" | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-3 undo | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-4 staff permission | security-and-tenancy, ADR-0013 | 2, 6 | Matrix level: `packages/core/src/permissions.test.ts` (staff `bookings.manage` only on own records) (S8); AI refusal: _tbd_ (Phase 6) |
| AC-W3-1/2 facts & warnings | memory | 7 | _tbd_ |
| AC-W4-1/2 feed suggestion, no duplicates | jobs-messaging-integrations, feed | 5, 8 | _tbd_ |
| AC-W5-1 waitlist | modules-and-templates | 8 | _tbd_ |
| AC-W6-1 reminders | jobs-messaging-integrations | 5 | _tbd_ |
| AC-W7-1/2/3 trust | ai-agent-and-trust-layer, memory | 6, 7 | _tbd_ |
| AC-W8-1/2 public booking | data-model (exclusion constraint), security | 3, 4 | _tbd_ |
| AC-W9-1 staff scope | security-and-tenancy, ADR-0013 | 2, 3 | Matrix + API level: `packages/core/src/permissions.test.ts` "AC-W9-1", route guard tests in `apps/api/src/team/team.controller.test.ts` (S8); own time off only: `packages/modules/appointments/src/appointments.int.test.ts` "cannot add or remove a colleague's time off", `auth.int.test.ts` "Cara cannot manage a colleague's time off" (S10); bookings/notes endpoints and staff-scoped RLS: _tbd_ (Phase 3) |
| AC-X-1 tenant isolation | security-and-tenancy, ADR-0010, ADR-0012 | 2+ | DB level: `packages/db/src/isolation.int.test.ts` (S6, + auth tables and `withUser` in S7, + `audit_log`/`usage_meters` and per-table grants in S8, + `invites` and the `invite_lookup` policy in S9; + the five appointments tables and cross-tenant references in `packages/db/src/appointments.int.test.ts` "references stay inside a business", S10; + `booking_rules`, S11); team endpoints: `auth.int.test.ts` "someone from another business is not found here" (S8); invites: `packages/core/src/invites.int.test.ts` "another business's invite", `auth.int.test.ts` "another business cannot see or revoke" (S9); endpoints: `apps/api/src/auth.int.test.ts` "across businesses" + `account.controller.test.ts` guard cases (S7); appointments endpoints: `auth.int.test.ts` "another business's owner finds none of it" (S10, + `/v1/rules` in S11); AI tools: _tbd_ (Phase 6) |
| Owner MFA, sign-in (v1-scope "Platform core") | ADR-0007, ADR-0012, security-and-tenancy | 2 | `apps/api/src/auth.int.test.ts` "owner journey", `packages/core/src/tenant-access.test.ts`, `e2e/tests/auth.spec.ts` (S7) |
| Roles/permissions matrix (v1-scope "Platform core", Phase 2 exit "role matrix 100%") | ADR-0013 | 2 | `packages/core/src/permissions.test.ts`, `membership-rules.test.ts`, `services.int.test.ts`; `apps/api/src/auth.int.test.ts` "team and audit log" (S8); invite grants: `membership-rules.test.ts` "canGrantRole", `permissions.test.ts` "permissionsOf" (S9) |
| Audit log (every write audited) | ADR-0013, data-model | 2+ | `packages/db/src/audit-usage.int.test.ts` (append-only, allowlist, rollback, erasure), isolation suite; `packages/core/src/services.int.test.ts` (entry per change) (S8); later writes: per phase |
| Invites (v1-scope "Platform core": invite staff) | ADR-0014, security-and-tenancy | 2 | `packages/db/src/invites.int.test.ts`, isolation suite "invite lookup"; `packages/core/src/invites.int.test.ts` (expired, reused, revoked, wrong account, escalation, other business, limit, concurrent accepts); `apps/api/src/team/invites.controller.test.ts`, `auth.int.test.ts` "invites"; `e2e/tests/team.spec.ts` (S9) |
| Usage metering skeleton | ADR-0013, data-model | 2 | `packages/db/src/audit-usage.int.test.ts` (sums, concurrency, tenants apart), `packages/core/src/usage-period.test.ts`, `services.int.test.ts` "usage" (S8) |
| AC-X-2 LLM outage degradation | reliability-and-observability | 6 | _tbd_ |
