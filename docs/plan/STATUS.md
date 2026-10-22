# Project Status — read this first in every new session

**Last updated:** 2026-10-21 · **Plan version:** 0.23 · **Current phase:** 6 — AI agent + trust layer. **S26b** (four week-one tools, explanation facts) done on its branch → next: **S27** (real-model evals, model choice, security review, Phase 6 exit)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S27 (Phase 6f), one session (user, 2026-10-22: "manage this whole thing in one session"), branch `ccr-6f440216-a30sbk`.** $0 spent so far.
- **Done (committed):**
  - Budget guards: `evals/ledger.json` → `docs/plan/ai-budget.md`, refuses a run over $1.50 or one taking the total past $4.50, stops mid-run at either, ≤ 25 cases a run (`--chunk`), both routes priced, replay-or-record (never pays twice), `--case`/`--routine`/`--strong`/`--label`.
  - Security fixes: `complete_todo` answers echoing the AI's own to-do titles are labelled untrusted; unblock Undo refuses (`slot_taken`) when a client was booked into the freed time since.
  - 81 new eval cases (114 total, 23 holdout = 20%), placeholder matchers, `actions.nothingDone`; CI replays scripted and (once recorded) OpenAI cassettes.
  - Time bombs fixed: proposals' `created_at` on the service clock; core `trust.int.test.ts` clock relative to today; the eval subject lists proposals on the world's clock (found by running the suites six weeks ahead).
  - `docs/engineering/security-review-s27.md` drafted (OWASP LLM 2026 + Agentic re-map, M1/M2 fixed, W1 watch, screen-reader script); its real-model section waits for the runs.
  - Checks: `pnpm check` green; `pnpm test:integration` green (973).
- **Next (paid, in order):** fill `evals/prices.json` from OpenAI's official pricing page; smoke 5 cases on each routine candidate (`--case … --routine <m> --strong <m> --label smoke`); full pass^1 in chunks `--chunk 1..5`; safety pass^3 in chunks of ~8 (`--set safety --trials 3 --case …`); fixes (tool descriptions first, one change, re-run failed only); reserve: stronger model on the hardest cases. Then ADR-0033, the Phase 6 exit record, docs, push.
- **Waiting on the user:** `OPENAI_API_KEY` as an environment secret, and allowed domains `api.openai.com`, `openai.com`, `developers.openai.com`, `platform.openai.com`, `owasp.org`, `genai.owasp.org` (cloud environment menu → Edit). A new secret may reach only a new session: then start one from this branch and say "continue S27 from STATUS".
- **Decisions in chat (2026-10-22):** one session, not S27a/S27b; the user approved the brief's other recommendations (refuse unblock-Undo over a new booking; routine model by evals, nano-class vs mini-class; 120-case target, 20% holdout); Sentry/Grafana wait for the start of Phase 11 pilot prep (Claude's advice, the user deferred to it).

## Last sessions
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
- **S26 Phase 6e (2026-10-21): chat screen, cards, Why, Undo, Autonomy settings** ([ADR-0031](../adr/0031-chat-screen-cards-why-undo-and-autonomy-settings.md), accepted; [PCR-004](changes/PCR-004.md), approved). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - `/chat` on `POST /v1/chat/turns`: plain-text streaming, resume with `Last-Event-ID`, Stop and cancel on leaving, chips, AI off/paused/fallback states.
    - `@pepper/ui` cards (change/confirmation/receipt, slot picker, client choice, booking, day, plan), *Why?*, Undo with its window and "already emailed"; `/autonomy`; Home's "Needs your OK" and "Done for you".
    - `/v1/ai/*` (live views, approve by fingerprint, reject, undo), `/v1/autonomy`, `/v1/chat/status`; migration 0036 (tool version, requester, summary).
    - `E2eModel` behind `AI_SCRIPTED_PROVIDER=e2e` (CI only, refused elsewhere and next to a key); a lint rule against raw HTML and Markdown.
  - **Checks:**
    - `pnpm check` green (contracts 547, core 1,190, ai 183, api 292, web 264, ui 103).
    - `pnpm test:integration` green, 943 (+15).
    - Playwright on CI's headless shell, phone and desktop, with axe: the full suite 74/74, twice in a row (an earlier run failed 2: a turn slower than Playwright's 5 s default, and an `ECONNRESET` from Node's 5 s keep-alive race; fixed with turn-length waits and a 65 s keep-alive on the web server). No OpenAI call.
  - **Found and fixed:**
    - A lead's approval turned a staff member's "me" into the lead.
    - Focus not returned after *Why?*.
    - A slot tapped during a turn was dropped.
    - Resumed turns lost their cards.
    - The scripted switch trusted a defaulted environment name.
    - The web server's 5 s keep-alive raced reused connections (`ECONNRESET`).
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
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S26 are done and merged (Phases 0–5, Phases 6a–6e); S26b (PCR-004) is done on its branch. Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session. Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S27 | Real-model evals within the $5 budget (sets in runs of ≤ 25 cases, 14 tools), model choice, Phase 6 security review (incl. tool summaries echoing a member's text), exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.
