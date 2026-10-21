# Project Status — read this first in every new session

**Last updated:** 2026-10-20 · **Plan version:** 0.18 · **Current phase:** 6 — AI agent + trust layer. **S22** (Phase 6 plan, provider adapter, eval skeleton) done and merged → next: **S23** (trust-layer data)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
Nothing in progress: S22 is complete; ADR-0027 accepted (user) and the PR is opened and merged to `main`. Next: S23 in a new session from `main`.

## Last sessions
- **S22 Phase 6a (2026-10-20): Phase 6 plan, provider adapter, eval runner skeleton** ([ADR-0027](../adr/0027-llm-provider-port-and-evals.md), accepted). Full entry in [session-log.md](session-log.md).
  - **Plan:** [phase-6-playbook.md](phase-6-playbook.md), confirmed by the user. It covers the market gap, differentiators D-1..D-5, the quality bar, design principles, the **$5 OpenAI budget (real calls only in S27)**, the eval strategy with a hostile fake, the OWASP LLM mapping, guides for S22–S27, §9 "Keep getting better" and an improvement log.
  - **Code:**
    - `contracts/ai.ts`: provider-neutral messages, tools, requests, responses and errors.
    - New `@pepper/ai` package:
      - the `LlmProvider` port and `LlmError`;
      - `OpenAiProvider` on the Responses API (`openai` 7.32.0, pinned; `store: false`, reasoning replay, prompt cache key, no SDK retries);
      - `ScriptedProvider`, `strictToolParameters`, `meteredProvider`, `loadOpenAiConfig`, `businessClock`;
      - the eval runner: cases, deterministic graders, pass^k, cassettes with request fingerprints, a budget guard, the report and `pnpm --filter @pepper/ai eval`;
      - three reference cases (look the client up first, "tomorrow" on the business clock, a pasted prompt injection).
  - **Checks:**
    - `pnpm check` green: ai 81 tests (87 after the late fix below, rerun: ~99.7% lines), contracts 492, others unchanged.
    - First eval run green on scripted cassettes at $0.
    - The record path refuses without a key, without a model price, and with a bad cap.
    - No real OpenAI call was made.
    - `pnpm test:integration` green: 712, unchanged (no database or app change).
  - **Found and fixed:**
    - the SDK raises a stream `error` event as an `APIError` without a status (now `unavailable`);
    - a non-numeric `--max-cost` would have disabled the cap (now refused).
- **M1 maintenance (2026-10-20):** `STATUS.md` split into this file, [session-log.md](session-log.md) and [decisions.md](decisions.md); checkpoint rule and generous-time-limits testing rule in `CLAUDE.md`; local Playwright in cloud sessions uses CI's headless shell; the session-start hook starts Docker with Google's mirror (`mirror.gcr.io`) so Docker Hub's rate limit no longer blocks pulls. No product code changed.

## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, S22):** $5 credit in total for Phase 6 with a hard limit, spent only at the final testing stage (S27); everything before runs on fake providers (playbook §4).
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S22 (user, 2026-10-20):**
  - Plan Phase 6 with great care, as the product's most important layer: Claude acts as senior advisor, and every decision must improve the product and stand out from the market.
  - **OpenAI budget: $5 in total for Phase 6, spent only at the final testing stage (S27).**
  - Phase 6 playbook confirmed, with a "keep getting better" rule.
  - The official `openai` SDK.
  - Sentry and Grafana Cloud deferred again.
- **End of S22 (user):** "ADR-0027 approved. Open PR and complete the merge."
- **S22 defaults (Claude, in ADR-0027, accepted by the user):**
  - Responses API with `store: false` and reasoning replay.
  - Our own retries, with a 30 s timeout.
  - Strict tool schemas from Zod (`.nullable()` instead of optional).
  - Model ids only from config, chosen in S27.
  - A call fails if it can't be metered.
  - Deterministic graders and cassettes.
  - A $1.50 per-run cap (at most $4.50), and a price table filled before any real run.

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S22 are done and merged (Phases 0–5, Phase 6a). Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session; details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S23 | **Trust layer data:** proposals, executions, undo records, autonomy settings, `decideAutonomy` (playbook §7 S23) | 6b | RLS + isolation; property tests for `decideAutonomy` |
| S24 | Tool registry + about ten tools with dry-run previews, inverses, permissions | 6c | Preview = execution and hostile-fake tests green |
| S25 | Agent loop, conversations, SSE, budgets and rate limits | 6d | Eval sets green on the fakes; AC-X-2 |
| S26 | Chat screen, cards, Why, Undo, Autonomy settings | 6e | Playwright journeys, axe |
| S27 | Real-model evals within the $5 budget, model choice, Phase 6 security review, exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.
