# Project Status — read this first in every new session

**Last updated:** 2026-10-23 · **Plan version:** 0.26 · **Current phase:** 7 — Memory ([Phase 7 playbook](phase-7-playbook.md), [PCR-005](changes/PCR-005.md)); **S29 done** (memory store, [ADR-0034](../adr/0034-memory-store-and-forget-everywhere.md)) → next: **S30** (facts in the AI)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
Nothing. S28 and S29 are finished and pushed to `claude/magical-knuth-ky75f5` (no PR yet).

## Last sessions
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
- **S28 Phase 7a (2026-10-23): Phase 7 planning** ([Phase 7 playbook](phase-7-playbook.md), approved; [PCR-005](changes/PCR-005.md), approved). Docs only. Full entry in [session-log.md](session-log.md).
  - **Plan:** S29 store → S30 facts in the AI → S31 episodes and learned rules → S32 "What I know" → S33 re-record, pass^3, security review, exit.
  - **Bar:** recall ≥ 95% (pass^3 ≥ 90%); deletion 100% at pass^3, graded on provider requests and storage; memory safety 100%; AC-W3-1/2, AC-W7-2. Phase 7 OpenAI cap $1.00, recorded per session on Luna + Sol.
  - **Review changes:** values live only in the memory tables, and one forget scrubs chat history, episodes and Undo values. Also visit notes ("same as last time"), the last visit on the booking card, the "Remembered" chip, a pause switch and `--phase-cap`.
  - **Checks:** `pnpm check` green.

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
1. **Before the pilot, at the start of Phase 11 pilot prep (user, S27):** create a free Sentry project and a Grafana Cloud stack (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`). Claude raises it at that brief.
2. **Before the pilot, by hand (S27 security review):** the 5-minute VoiceOver/NVDA check of the streamed chat; confirm the OWASP LLM/Agentic Top 10 2026 titles in the signed-in PDFs on genai.owasp.org; check zero data retention eligibility on the OpenAI account (L2).
3. **Optional:** S27 spent $0.74 of the $5 credit. Phase 7 may use up to $1.00 of the rest (playbook §4); a full re-record costs about $0.06.

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S27 are done and merged (Phases 0–6). S28 (Phase 7 planning) and S29 (memory store) are done on their branch. Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S30 | Facts in the AI: `remember_fact`, `add_visit_note`, `forget_fact`, recall with the entity, warnings and last visit on booking cards (AC-W3-2), "the usual"; evals recorded on Luna + Sol | 7c | Playbook §7 S30 |
| S31 | Episodes (`search_memory`) and learned rules (`rule.change`) | 7d | Playbook §7 S31 |
| S32 | "What I know", client profile memory and visit notes, "Remembered" chip, pause switch | 7e | AC-W3-1, AC-W7-2 in Playwright |
| S33 | Full re-record, pass^3, security review, Phase 7 exit | 7f | Playbook §2 met |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.
