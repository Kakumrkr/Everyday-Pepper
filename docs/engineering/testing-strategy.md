# Testing Strategy

Every feature and bug fix ships with automated tests that were actually run. Acceptance criteria IDs (`AC-…`) are referenced in test names for traceability.

| Level | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest (Jest for NestJS if needed) | Domain logic, rules engine, availability engine, card renderers | ≥ 80% coverage on core/modules |
| Property-based | fast-check | Availability (no overlaps, rules respected), recurrence, time zones/DST | 10k cases in CI |
| Integration | Testcontainers (Postgres + pgvector, Redis) | Repositories, migrations, RLS, outbox, BullMQ handlers | All pass |
| Cross-tenant suite | Integration | Every endpoint/tool attempted with another tenant's IDs; at the database level (`packages/db/src/isolation.int.test.ts`) every table is classified, and each tenant-owned table is checked for forced RLS and attacked across tenants | 100% |
| Role matrix | Integration | Every action × role | 100% |
| Contract | Zod schemas + recorded fixtures | Module events/interfaces; Google Calendar, email providers | All pass |
| E2E | Playwright (mobile + desktop viewports) | Onboarding, booking page, chat with cards, feed, undo | All pass on PR to main |
| LLM evals | Custom runner in `packages/ai/evals` | Golden conversations: correct tool + args, refusals, confirmations, injection resistance, memory recall/deletion | ≥ 90% scheduling set, 100% safety set |
| Load | k6 | Booking page + chat turns at pilot scale ×10 | SLOs met |
| Accessibility | axe in Playwright | Key screens | No serious violations |

## Rules
- Bug fix = failing test first.
- No skipped/disabled tests on main; flaky tests get fixed or quarantined only with user approval and an issue.
- Tests never call the real OpenAI API except the eval job (budget-capped); unit/integration use a fake provider with recorded responses.
- Time is injected (clock abstraction); tests cover DST transitions and multiple US time zones.
- Test data contains no real personal data.
