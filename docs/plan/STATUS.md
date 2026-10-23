# Project Status — read this first in every new session

**Last updated:** 2026-10-23 · **Plan version:** 0.24 · **Current phase:** 6 — AI agent + trust layer, **exit met in S27** (real-model evals, model choice, security review), done on its branch → next: **S28** (Phase 7 planning: memory)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
Nothing. S27 is finished and pushed to `ccr-6f440216-a30sbk` (no PR yet).

## Last sessions
- **S27 Phase 6f (2026-10-22/23): real-model evals, model choice, security review, Phase 6 exit** ([ADR-0033](../adr/0033-real-model-evals-and-model-choice.md), accepted; [security review](../engineering/security-review-s27.md)). Full entry in [session-log.md](session-log.md).
  - **Models:** routine `gpt-6-luna` (effort `low`), strong `gpt-6.1-sol` (effort `low`). Chosen from a full pass of Luna and `gpt-5.4-mini`: a tie on quality, and Luna's calls are 8× cheaper. Set them with `OPENAI_MODEL_*` and `OPENAI_REASONING_*` (`.env.example`).
  - **Results:** every gate met. Scheduling 97% (pass^3 95%); safety, permissions and autonomy 100% at pass^3; about $0.0005 a case. **Spent $0.74 of $5**, every run in [ai-budget.md](ai-budget.md).
  - **Changes:** four fixes (three tool descriptions, one instruction line), routing to the strong model after step 4, web addresses removed from the AI's text in code. Cache writes are metered. `cassettes/openai` is replayed in CI.
  - **Checks:**
    - `pnpm check` green (ai 226 unit tests).
    - `pnpm test:integration` green, 974.
    - Playwright 74/74, twice.
  - **Phase 6 exit: met.**
- **S26b Phase 6e+ (2026-10-21): four week-one tools, facts behind *Why?*** ([ADR-0032](../adr/0032-four-week-one-tools-and-explanation-facts.md), accepted; [PCR-004](changes/PCR-004.md)). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - Tools (14 now): `find_client_bookings`, `list_todos`, `complete_todo` (dial `task.create`, Undo reopens while unchanged), `unblock_time` (dial `time.block`, Undo re-blocks the span); `get_day` v2 lists block ids.
    - Domain: db `listClientBookings`, `findTimeOff`; appointments `listClientBookingsIn`, `getTimeOffIn`; core `listTasksIn`, `changeTaskIn`, `completeTaskIn`, `reopenTaskIn`, `memberFirstNamesIn`, `TaskNotOpenError`.
    - *Why?* "What I checked": `Performed.facts` → `ActionPreview.facts` → `AiWhy.facts` → `factLine`; change rows for a completion and an unblock; a to-do chip in the empty chat.
  - **Checks:**
    - `pnpm check` green (contracts 548, core 1,190, ai 192, api 292, web 264, ui 107).
    - `pnpm test:integration` green, 969 (+26).
    - Hostile fake 100% as owner and staff (direct and through the loop); evals on the fakes incl. 8 new generated cases; Playwright chat journeys 14/14 (phone, desktop, axe). No OpenAI call.
  - **Found and fixed:** the hostile test's mini-loop outgrew the 200-message request limit; the cost guard's 30-case run no longer fits $1.50 with 14 tools (now 25; S27 chunks sets).
## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, S22):** $5 credit in total for Phase 6 with a hard limit, spent only at the final testing stage (S27); everything before runs on fake providers (playbook §4). S27 spent $0.74 ([ai-budget.md](ai-budget.md)); later phases use the rest under the same policy.
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S27 (user, 2026-10-22, Session Brief):** one session; unblock Undo refuses over a new booking; routine model by evals; about 120 cases with 20% held out; Sentry/Grafana at the start of Phase 11 pilot prep (Claude's advice). **Claude (ADR-0033, choice delegated "by pass rate, latency and cost"):** Luna + Sol at effort `low`; the strong model after step 4; the link scrubber; case corrections only where a case contradicted the world, the dial or the privacy rules; the reserve was not spent.
- **S26b (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, ADR is pre-approved": a staff member unblocking a colleague's time is `forbidden` (they can see it); explanation facts this session; no new card kinds or Playwright journeys.
- **S26b defaults (Claude, in ADR-0032):** `find_client_bookings` 5 upcoming / 3 recent without a window; `list_todos` 20, titles redacted, the AI's own to-dos labelled untrusted; `get_day` v2; preview facts are the explanation's; change rows read from the sides' shape; the cost guard's one run is 25 cases (S27 chunks sets).
- **S26 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, draft PCR-004, ADR is pre-approved":
  - migration 0036 in ADR-0031 as an ADR-0028 amendment, without a PCR;
  - staff may undo what a lead approved for them;
  - jsdom, Testing Library and axe-core (dev-only) in `@pepper/ui`;
  - managers change autonomy (ADR-0028 over the prototype);
  - the chat's Redis polling stays; blocking reads in Phase 11;
  - PCR-004: S26b (four tools) before S27.
- **End of S26 (user, pre-approved at the brief):** "I'm pre-approving the PCR and ADR. You have to raise PR and merge to main and at last give a perfect prompt to start the next session."
- **S26 defaults (Claude, in ADR-0031):** cards read their record by id; Approve sends only the shown fingerprint; `ToolDeps.requester`; plain text only; Stop and leaving cancel; a card choice during a turn is queued; "Approve all" in order, stopping at the first failure.
- **S25 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, ADR is fine": own-only conversations, deleted after 90 days; 5M tokens a month, soft at 80%; turns keep running when the connection drops (explicit cancel only); ADR-0027/0029 amendments in ADR-0030 without a PCR. D8 decided: SSE.
- **S25 defaults (Claude, in ADR-0030):** 6 steps / 20 s / 5 writes; reads parallel, writes serial; tool calls recorded before they run, recovery only reads; breaker 3 → 30 s; rate limits 20 / 5 min per member; events in a Redis stream (1 h).

## Waiting on the user
1. **Before the pilot, at the start of Phase 11 pilot prep (user, S27):** create a free Sentry project and a Grafana Cloud stack (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`). Claude raises it at that brief.
2. **Before the pilot, by hand (S27 security review):** the 5-minute VoiceOver/NVDA check of the streamed chat; confirm the OWASP LLM/Agentic Top 10 2026 titles in the signed-in PDFs on genai.owasp.org; check zero data retention eligibility on the OpenAI account (L2).
3. **Optional:** S27 spent $0.74 of the $5 credit. The rest stays on the account for Phase 7–9 evals (a full re-record costs about $0.06).

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S26 are done and merged (Phases 0–5, Phases 6a–6e). S26b and S27 are done on their branches (Phase 6 exit met in S27). Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S28 | Phase 7 planning (memory: facts, learned rules, episodic recall with pgvector, "What I know" page): split it into sessions like the Phase 6 playbook, with its eval sets (recall ≥ 95%, deletion 100%) recorded on the chosen models from the start | 7a | Plan approved; first session's target set |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.
