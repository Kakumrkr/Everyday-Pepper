# Testing Strategy

Every feature and bug fix ships with automated tests that were actually run. Acceptance criteria IDs (`AC-…`) are referenced in test names for traceability.

| Level | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest (Jest for NestJS if needed) | Domain logic, rules engine, availability engine, card renderers | ≥ 80% coverage on core/modules |
| Property-based | fast-check | Availability (no overlaps, rules respected), recurrence, time zones/DST | 10k cases in CI |
| Integration | Testcontainers (Postgres + pgvector, Redis, Mailpit with its chaos API for SMTP failures) | Repositories, migrations, RLS, outbox, BullMQ handlers | All pass |
| Cross-tenant suite | Integration | Every endpoint/tool attempted with another tenant's IDs. At the database level (`packages/db/src/isolation.int.test.ts`), every table is classified as tenant-owned or global (auth tables, with a reason). Each tenant-owned table is checked for forced RLS and attacked across tenants, and the read-only `withUser` context is attacked too. At the endpoint level (`apps/api/src/auth.int.test.ts`): switching to or reading a foreign business, tenant ids smuggled in body, query or header, membership removal, and Better Auth's `update-session` | 100% |
| Role matrix | Unit + integration | Every action × role: `packages/core/src/permissions.test.ts` pins every cell (and own/colleague/unassigned records), `membership-rules.test.ts` every role × target × change; `packages/core/src/services.int.test.ts` runs the services against Postgres (incl. concurrent owner changes); `apps/api` tests the route guards and endpoints per role | 100% |
| Contract | Zod schemas + recorded fixtures | Module events/interfaces; Google Calendar, email providers, the SMS provider (Twilio's documented shapes, `packages/runtime/src/fixtures/twilio`, S61; S63: replies end to end through the sandbox's `/v1/dev/sms`, mounted only with `SMS_PROVIDER=sandbox` where tests run) | All pass |
| E2E | Playwright (every journey on the phone project; the desktop project runs `screens`, `gallery`, `shell` and `accessibility`, S47.3) | Auth (S7, `e2e/tests/auth.spec.ts`: sign up → business → MFA setup → sign out → sign in with TOTP or backup code; TOTP codes from `totpCode` in `@pepper/testing`), onboarding, the timed new-owner journey (S47.3, `e2e/tests/new-owner-journey.spec.ts`, phone only: every action charged with the owner time model in `@pepper/testing`, owner < 10 min, client < 2 min and < 60 s from a remembered phone; the wall clock printed beside it), booking page, chat with cards, feed, undo | All pass on PR to main |
| LLM evals | Custom runner in `packages/ai/src/evals` with cases and cassettes in `packages/ai/evals` (ADR-0027, playbook §5) | Golden conversations: correct tool + args, refusals, confirmations, injection resistance, memory recall/deletion; deterministic graders, pass^k; replayed from cassettes in CI | ≥ 90% scheduling set, 100% safety set |
| Load | k6 | Booking page + chat turns at pilot scale ×10 | SLOs met |
| Visual | Playwright `toHaveScreenshot` (`e2e/tests/gallery.spec.ts`, S40, ADR-0044): the component gallery at 375 / 412 / 1280 px × light / dark and the approval sheet; from S41 `e2e/tests/screens.spec.ts`: Home, Chat and More at the same widths and themes (a new owner of "Southside Cuts", the briefing settled, the email masked); baselines in `e2e/tests/__screenshots__/`, made on Linux with CI's headless shell, 1% pixel tolerance | Every kit component; Home, Chat and More (S41); the other screens in S42–S43 | A diff fails CI unless the PR updates the baseline (`playwright test gallery --project=desktop --update-snapshots`) and shows the change |
| Accessibility | axe in Playwright (`@axe-core/playwright`, `e2e/tests/accessibility.spec.ts`, S18) | Key screens, WCAG 2.2 A/AA tags, light and dark, phone and desktop; from S41 the tap-target check (`e2e/tests/tap-targets.ts`, DESIGN D3: every visible control ≥ 44 × 44 px, links inside a sentence exempt) on the shell, Home and More at 375 px | No serious or critical violations (lesser ones are reported as annotations) |

## Rules
- Bug fix = failing test first.
- No skipped/disabled tests on main; flaky tests get fixed or quarantined only with user approval and an issue.
- Tests never call the real OpenAI API. Unit and integration tests use the scripted fake or fixtures shaped like OpenAI's documented API; evals replay cassettes. Only `pnpm --filter @pepper/ai eval --provider openai --record` calls the API: in S27, with a key, a model price and an estimate under the per-run cap (Phase 6 budget $5, playbook §4).
- Time is injected (clock abstraction); tests cover DST transitions and multiple US time zones.
- Test data contains no real personal data.
- Code-change tests run in tiers (M2, `CLAUDE.md` "Running tests"): the changed package's tests and the touched integration files while building, typecheck and lint of what changed at each checkpoint, and, at the end after review/fixes, `pnpm check`, the affected packages' integration tests (`TURBO_SCM_BASE=origin/main pnpm turbo run test:integration --affected`) and the changed screens' and flows' Playwright specs, one local suite at a time; the full suites run once in CI, inside the session, which fixes a red run at its root cause before merging (user, 2026-11-03). Prose-only work uses the selection matrix below (PCR-009). A red step re-runs affected failing cases and any new scope; CI remains unchanged.
- Tests that pass locally must pass on GitHub, whose runners are slower (2 CPUs) and run several packages at once: anything that waits on time (polling, property runs, start-up, a long replay) uses generous explicit limits (`expect.poll`/`vi.waitFor` with a `timeout`, never the 1 s default; a test cap at least 3× its measured time, as the eval replays and the bookings property test since S47.3). Performance gates (latency p95s) keep their limits: a miss is diagnosed and made faster (S47.3, migration 0057). CI has no retries; a failure is fixed, never retried away. In cloud sessions Playwright runs CI's headless shell (see [dev-setup](dev-setup.md)).

## Check selection from S46 through launch

Classify the actual final diff, including intended new files and downstream consumers, rather than choosing by the session name. The brief names the profile; the close rechecks it if the scope changed. This matrix is the maintained source for check selection; `/session-close` supplies the commands and order.

| Profile | During work | Local close | CI and boundaries |
|---|---|---|---|
| Non-runtime prose/planning/workflow Markdown only | Review facts, decisions, instructions and affected references | Diff/whitespace, affected relative links and acceptance-ID/reference consistency when applicable; skill validation for edited skills where available | Existing docs-only CI behavior; no app build, Docker or application suites when none consumes the changes |
| UI/screens or user flows | Changed UI/package logic tests and affected browser specs; typecheck/lint changed scope and dependents | `pnpm check`; the changed screens' and flows' specs (and `screens.spec.ts`) locally, full Playwright in CI; affected integration only if its code also changed | Normal required CI; retain mobile/desktop, visual/accessibility and relevant domain guarantees |
| Backend/domain/schema/integration | Changed unit and integration files; typecheck/lint affected packages and dependents | `pnpm check`; affected packages' integration locally, all of it in CI; the changed flows' specs if a user-visible flow changed | Normal required CI; retain isolation, permissions, concurrency, idempotency and migration checks |
| AI/prompt/tool or mixed/uncertain change | Affected logic, integrations and scripted evals; downstream screens/flows as needed | Normal code-change gates above, including applicable replay; real-model recording only in its approved session and budget | Normal required CI; safety and eval thresholds unchanged; runtime-loaded Markdown is a code input, not prose-only |

A Markdown extension alone does not qualify for prose-only checks. Runtime prompts, templates, fixtures, executable scripts, dependencies/lockfiles, build inputs or configuration require checks of the behavior they affect. If uncertain, use the normal code-change path. Review workflow-instruction changes for preserved check coverage, failure handling and publication authorization.

## Avoid repeated work without weakening gates

- Focus checks during implementation. Reuse already-passed targeted evidence at the same checkpoint only while code, dependencies, fixtures, configuration and relevant environment are unchanged. Run the required final code-change checks once after review/fixes; this rule does not eliminate the final run.
- If review fixes touch a new area, check that area and its consumers. Repeat a full suite only when changed scope, unresolved concerns or new failures justify it; diagnose repeated unchanged failures instead of using another full run as the fix. No hidden retries, loosened thresholds, disabled cases or smaller meaningful fixtures.
- Keep local full suites sequential. Reuse a valid stack for related checks, rebuild when inputs require it, and use existing build caching. Do not remove an apparent duplicate build before verifying host-versus-container output requirements.
- Reuse deliberate screenshot baselines and walk one changed customer/owner/staff flow as required by the session standard; do not recreate screenshots of every unaffected screen.
- In the existing session-log entry, record one compact timing line from available logs: setup/build, targeted checks, final suites, walkthrough/rework, CI execution and time between attempts. Use "unknown" when not measured. No new report/dashboard or test rerun just to collect timing.

## Efficiency baseline and next investigation

Read on a performance/CI maintenance review, not as mandatory context for each feature session. These are actual Actions timings, not full Claude development-session timings:

| Source | Observed elapsed time | Interpretation |
|---|---|---|
| [S44 successful run](https://github.com/kakumaniramakrishnarao/Everyday-Pepper/actions/runs/40788762841) | 20 min 18 s | Recent successful CI baseline |
| [S45 earlier failed run](https://github.com/kakumaniramakrishnarao/Everyday-Pepper/actions/runs/40818175681) | 22 min 15 s | Remembered-fact chat browser case failed; cause not diagnosed here |
| [S45 eventual successful run](https://github.com/kakumaniramakrishnarao/Everyday-Pepper/actions/runs/40820780831) | 65 min 9 s | First attempt ~20 min, ~32 min gap after its last job, then ~13 min integration rerun; gap cause unknown |

The original S45 integration attempt failed episode-search latency: p95 **615.43 ms** over the existing **450 ms** failure limit (already 3× the 150 ms target). A later rerun passed. Resource contention is plausible from integration configs/history, not established as the cause. Diagnose it; do not increase the threshold or retry it away. **Diagnosed in S47.3:** exact search read every ~6 KB vector back from TOAST (`EXPLAIN (ANALYZE, BUFFERS)`: 15,128 buffers against 6,000 in-row); migration 0057 stores the embedding `PLAIN`, and the gate's search p95 fell from 45 to 24 ms alone and from 61 to 32 ms under six busy CPU loops, with the 450 ms limit, 20 runs and 150 ms target unchanged. S45's retained browser job took 19 min 44 s, including 3 min 28 s stack startup and a 15 min 11 s browser command/build prerequisite. Its unit/coverage step was 2 min 6 s; jobs run in parallel, so their durations cannot be added as wall time.

Use a separate bounded maintenance session to inspect browser fixture/setup cost and package/file concurrency, and to compare controlled latency execution with the current complete run. Keep the same assertions, fixture scale and every-PR checks during investigation. Do not serialize operations inside race-condition tests. No CI/helper/runtime changes or measured speedup are claimed by this workflow refinement.
