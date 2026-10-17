# Traceability Matrix

Links each requirement to its design and tests. Test columns are filled in as phases are built; an empty test cell at phase exit is a blocker.

| Requirement | Design | Phase | Tests |
|---|---|---|---|
| AC-W1-1/2 onboarding draft & confirm | jobs-messaging-integrations (extraction), modules-and-templates | 9 | _tbd_ |
| AC-W1-3 CSV import idempotent | jobs-messaging-integrations | 9 | _tbd_ |
| AC-W2-1 conflict → alternatives | modules-and-templates (availability), ai-agent | 3, 6 | _tbd_ |
| AC-W2-2 autonomy "ask" | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-3 undo | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-4 staff permission | security-and-tenancy, ADR-0013 | 2, 6 | Matrix level: `packages/core/src/permissions.test.ts` (staff `bookings.manage` only on own records) (S8); AI refusal: _tbd_ (Phase 6) |
| AC-W3-1/2 facts & warnings | memory | 7 | _tbd_ |
| AC-W4-1/2 feed suggestion, no duplicates | jobs-messaging-integrations, feed | 5, 8 | _tbd_ |
| AC-W5-1 waitlist | modules-and-templates | 8 | _tbd_ |
| AC-W6-1 reminders | jobs-messaging-integrations | 5 | _tbd_ |
| AC-W7-1/2/3 trust | ai-agent-and-trust-layer, memory | 6, 7 | _tbd_ |
| AC-W8-1/2 public booking | data-model (exclusion constraint), security | 3, 4 | _tbd_ |
| AC-W9-1 staff scope | security-and-tenancy, ADR-0013 | 2, 3 | Matrix + API level: `packages/core/src/permissions.test.ts` "AC-W9-1", route guard tests in `apps/api/src/team/team.controller.test.ts` (S8); bookings/notes endpoints and staff-scoped RLS: _tbd_ (Phase 3) |
| AC-X-1 tenant isolation | security-and-tenancy, ADR-0010, ADR-0012 | 2+ | DB level: `packages/db/src/isolation.int.test.ts` (S6, + auth tables and `withUser` in S7, + `audit_log`/`usage_meters` and per-table grants in S8); team endpoints: `auth.int.test.ts` "someone from another business is not found here" (S8); endpoints: `apps/api/src/auth.int.test.ts` "across businesses" + `account.controller.test.ts` guard cases (S7); AI tools: _tbd_ (Phase 6) |
| Owner MFA, sign-in (v1-scope "Platform core") | ADR-0007, ADR-0012, security-and-tenancy | 2 | `apps/api/src/auth.int.test.ts` "owner journey", `packages/core/src/tenant-access.test.ts`, `e2e/tests/auth.spec.ts` (S7) |
| Roles/permissions matrix (v1-scope "Platform core", Phase 2 exit "role matrix 100%") | ADR-0013 | 2 | `packages/core/src/permissions.test.ts`, `membership-rules.test.ts`, `services.int.test.ts`; `apps/api/src/auth.int.test.ts` "team and audit log" (S8) |
| Audit log (every write audited) | ADR-0013, data-model | 2+ | `packages/db/src/audit-usage.int.test.ts` (append-only, allowlist, rollback, erasure), isolation suite; `packages/core/src/services.int.test.ts` (entry per change) (S8); later writes: per phase |
| Usage metering skeleton | ADR-0013, data-model | 2 | `packages/db/src/audit-usage.int.test.ts` (sums, concurrency, tenants apart), `packages/core/src/usage-period.test.ts`, `services.int.test.ts` "usage" (S8) |
| AC-X-2 LLM outage degradation | reliability-and-observability | 6 | _tbd_ |
