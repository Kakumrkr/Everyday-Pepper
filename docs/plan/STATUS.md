# Project Status — read this first in every new session

**Last updated:** 2026-10-23 · **Plan version:** 0.27 · **Current phase:** 7 — Memory ([Phase 7 playbook](phase-7-playbook.md), [PCR-005](changes/PCR-005.md)); **S30 built and green on the fakes** ([ADR-0035](../adr/0035-facts-in-the-ai.md)) → next: **S30b** (record on Luna + Sol, then PR and merge), then S31

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S30 is built, committed and pushed on `claude/great-cori-t020a2`; no PR yet.** The container had no `OPENAI_API_KEY`, and every request changed, so CI's replay of the recorded real model fails as stale until it is re-recorded. A PR now would run CI red.
- **Next (S30b), in order:**
  1. check that `OPENAI_API_KEY` is set and `api.openai.com` is reachable;
  2. record every set on Luna + Sol with `--phase 7`, in chunks of 20 (`--chunk 1, 2…`), against `EVAL_DATABASE_URL` from `eval-db.ts` (ADR-0033); expected about $0.10–0.15 of the $1 Phase 7 cap;
  3. check the gates: memory_delete and memory_safety 100%, memory_recall ≥ 95%, memory_write ≥ 90%, the Phase 6 sets as in S27; fix what fails and record only those again;
  4. `pnpm check`, `pnpm test:integration` (the replay is green again), the ledger in ai-budget.md and the eval report;
  5. open the PR, merge after one green CI run; update STATUS, session log and decisions.
- **Decisions made in chat:** none beyond the brief (decisions.md "S30").

## Last sessions
- **S30 Phase 7c (2026-10-23): facts in the AI** ([ADR-0035](../adr/0035-facts-in-the-ai.md), pre-approved). Full entry in [session-log.md](session-log.md).
  - **Built:**
    - `remember_fact`, `add_visit_note`, `forget_fact` (always asks). A value is stashed as a proposed fact, so proposals, receipts and *Why?* hold its id (migration 0040);
    - facts come with the records tools return, by reference, filled in for each request as the member; the business's own facts sit in the instructions;
    - booking warnings and the last visit from template config (AC-W3-2); "the usual", "same as last time";
    - memory on cards and in *Why?*, read live; a Playwright journey;
    - eval sets memory_write/recall/delete/safety (49 cases, 10 held out), deletion graded on the requests sent; the free-time description fix (D-4).
  - **Checks:**
    - `pnpm check` green;
    - integration 1,056 with one failure, the stale real-model replay (by design until re-recorded);
    - Playwright 76/76;
    - $0 spent.
  - **Found while building:** recalled facts must not make every save ask (only outside text does); concurrent saves of one key now take turns.
- **S29 Phase 7b (2026-10-23): memory store, forget everywhere, embedding port** ([ADR-0034](../adr/0034-memory-store-and-forget-everywhere.md), accepted). Full entry in [session-log.md](session-log.md).
  - **Built:**
    - migrations 0037–0039: pgvector, `memory_facts` (one active value per subject and key, visit notes, sensitive, staff scope), `memory_episodes` (own-only, exact search), `tenants.memory_paused`;
    - **forget everywhere:** deleting a fact scrubs its value from every member's stored chats (text, tool calls, cards, reasoning items) and episodes written since it existed, plus its source turn;
    - core memory services, the pause switch, the clean-up;
    - the `Embedder` port (OpenAI, hash fake, metered; `OPENAI_MODEL_EMBEDDING` optional);
    - the runner's `--phase` cap (Phase 7: $1).
  - **Checks:**
    - `pnpm check` green (contracts 556, db 48, core 1,190, ai 250).
    - `pnpm test:integration` green, 1,015 (+41).
    - Playwright 74/74.
    - $0 spent.
  - **Self-review fixed:** an erase-a-word attack through save-then-forget (scrub limited to the fact's lifetime), quoted values in tool calls, cards that could outgrow their schema.
## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, S22):** $5 credit in total for Phase 6 with a hard limit, spent only at the final testing stage (S27); everything before runs on fake providers (playbook §4). S27 spent $0.74 ([ai-budget.md](ai-budget.md)); later phases use the rest under the same policy. **Phase 7 (S28):** at most $1.00 of the rest, recorded per session from S30 on Luna + Sol; the runner enforces it (`--phase 7`).
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S30 (user, 2026-10-23, Session Brief):** "Go ahead with your recommendations, ADR is pre-approved"; PR and merge at the end, then the next session's prompt. D-1 `forget_fact` always asks (no new dial action); D-2 a save after outside text asks; D-3 no warning without read access; D-4 free-time fix now; D-5 one trial of every set; D-7 record when the key is there. **Claude (ADR-0035):** stash values as proposed facts; references filled per request; only outside text makes saves ask; saves of a key take turns; real runs in chunks of 20.
- **S29 (user, 2026-10-23):** "Go ahead with your recommendations, start S29". Embedding tests on fixtures shaped like OpenAI's documented answers ($0); real embeddings recorded in S31. **Claude (ADR-0034):** `embed` as a port of its own; the scrub limited to text since the fact existed plus its source turn; cards that held a forgotten value dropped; staff read the business's non-sensitive facts and change only their clients' and visits'; `--phase` required to record.
- **S28 (user, 2026-10-23):** asked for the Phase 7 playbook, then "review your plan, if you can build a better plan you can, and start" (Claude as technical advisor: better, more and more efficient features than competitors). Approved: the reviewed playbook and PCR-005 (§10 D-1…D-16), adjustable at the S29 brief.
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
1. **Now, for S30b:** add `OPENAI_API_KEY` in the environment settings (Network secrets or an environment variable; `api.openai.com` allowed). A new session picks it up.
2. **Before the pilot, at the start of Phase 11 pilot prep (user, S27):** create a free Sentry project and a Grafana Cloud stack (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`). Claude raises it at that brief.
3. **Before the pilot, by hand (S27 security review):** the 5-minute VoiceOver/NVDA check of the streamed chat; confirm the OWASP LLM/Agentic Top 10 2026 titles in the signed-in PDFs on genai.owasp.org; check zero data retention eligibility on the OpenAI account (L2).
4. **Optional:** S27 spent $0.74 of the $5 credit. Phase 7 may use up to $1.00 of the rest (playbook §4); a full re-record costs about $0.06.

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S29 are done and merged (Phases 0–6, Phase 7 planning and store). S30 is built on its branch; its recording, PR and merge are S30b. Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S30b | Record S30 on Luna + Sol (`--phase 7`, chunks of 20), meet the memory gates, PR and merge | 7c | Replay green; memory_delete/safety 100%, recall ≥ 95% |
| S31 | Episodes (`search_memory`) and learned rules (`rule.change`) | 7d | Playbook §7 S31 |
| S32 | "What I know", client profile memory and visit notes, "Remembered" chip, pause switch | 7e | AC-W3-1, AC-W7-2 in Playwright |
| S33 | Full re-record, pass^3, security review, Phase 7 exit | 7f | Playbook §2 met |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.
