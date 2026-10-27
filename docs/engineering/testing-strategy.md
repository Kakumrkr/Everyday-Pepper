# Testing Strategy

Every feature and bug fix ships with automated tests that were actually run. Acceptance criteria IDs (`AC-…`) are referenced in test names for traceability.

| Level | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest (Jest for NestJS if needed) | Domain logic, rules engine, availability engine, card renderers | ≥ 80% coverage on core/modules |
| Property-based | fast-check | Availability (no overlaps, rules respected), recurrence, time zones/DST | 10k cases in CI |
| Integration | Testcontainers (Postgres + pgvector, Redis, Mailpit with its chaos API for SMTP failures) | Repositories, migrations, RLS, outbox, BullMQ handlers | All pass |
| Cross-tenant suite | Integration | Every endpoint/tool attempted with another tenant's IDs. At the database level (`packages/db/src/isolation.int.test.ts`), every table is classified as tenant-owned or global (auth tables, with a reason). Each tenant-owned table is checked for forced RLS and attacked across tenants, and the read-only `withUser` context is attacked too. At the endpoint level (`apps/api/src/auth.int.test.ts`): switching to or reading a foreign business, tenant ids smuggled in body, query or header, membership removal, and Better Auth's `update-session` | 100% |
| Role matrix | Unit + integration | Every action × role: `packages/core/src/permissions.test.ts` pins every cell (and own/colleague/unassigned records), `membership-rules.test.ts` every role × target × change; `packages/core/src/services.int.test.ts` runs the services against Postgres (incl. concurrent owner changes); `apps/api` tests the route guards and endpoints per role | 100% |
| Contract | Zod schemas + recorded fixtures | Module events/interfaces; Google Calendar, email providers | All pass |
| E2E | Playwright (mobile + desktop viewports) | Auth (S7, `e2e/tests/auth.spec.ts`: sign up → business → MFA setup → sign out → sign in with TOTP or backup code; TOTP codes from `totpCode` in `@pepper/testing`), onboarding, booking page, chat with cards, feed, undo | All pass on PR to main |
| LLM evals | Custom runner in `packages/ai/src/evals` with cases and cassettes in `packages/ai/evals` (ADR-0027, playbook §5) | Golden conversations: correct tool + args, refusals, confirmations, injection resistance, memory recall/deletion; deterministic graders, pass^k; replayed from cassettes in CI | ≥ 90% scheduling set, 100% safety set |
| Load | k6 | Booking page + chat turns at pilot scale ×10 | SLOs met |
| Visual | Playwright `toHaveScreenshot` (`e2e/tests/gallery.spec.ts`, S40, ADR-0044): the component gallery at 375 / 412 / 1280 px × light / dark and the approval sheet; baselines in `e2e/tests/__screenshots__/`, made on Linux with CI's headless shell, 1% pixel tolerance | Every kit component; screens from S41 | A diff fails CI unless the PR updates the baseline (`playwright test gallery --project=desktop --update-snapshots`) and shows the change |
| Accessibility | axe in Playwright (`@axe-core/playwright`, `e2e/tests/accessibility.spec.ts`, S18) | Key screens, WCAG 2.2 A/AA tags, light and dark, phone and desktop | No serious or critical violations (lesser ones are reported as annotations) |

## Rules
- Bug fix = failing test first.
- No skipped/disabled tests on main; flaky tests get fixed or quarantined only with user approval and an issue.
- Tests never call the real OpenAI API. Unit and integration tests use the scripted fake or fixtures shaped like OpenAI's documented API; evals replay cassettes. Only `pnpm --filter @pepper/ai eval --provider openai --record` calls the API: in S27, with a key, a model price and an estimate under the per-run cap (Phase 6 budget $5, playbook §4).
- Time is injected (clock abstraction); tests cover DST transitions and multiple US time zones.
- Test data contains no real personal data.
- Tests run in tiers (M2, `CLAUDE.md` "Running tests"): the changed package's tests and the touched integration files while building, typecheck and lint of what changed at each checkpoint, and `pnpm check`, `pnpm test:integration` and Playwright in full once at the end, one suite at a time.
- Tests that pass locally must pass on GitHub, whose runners are slower and run every suite at once: anything that waits on time (polling, property runs, start-up) uses generous explicit limits (`expect.poll`/`vi.waitFor` with a `timeout`, never the 1 s default). CI has no retries; a failure is fixed, never retried away. In cloud sessions Playwright runs CI's headless shell (see [dev-setup](dev-setup.md)).
