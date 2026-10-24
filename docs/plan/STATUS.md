# Project Status — read this first in every new session

**Last updated:** 2026-10-24 · **Plan version:** 0.30 · **Current phase:** 7 — Memory, **done** (S33: every playbook §2 gate checked on Luna + Sol, [ADR-0038](../adr/0038-what-i-know-and-the-remembered-chip.md) "S33", [security review](../engineering/security-review-s33.md)) → next: **S34** (Phase 8 planning)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S34 (Phase 8a, planning)**, brief approved (user, 2026-10-24: "Go ahead with your recommendations"): layout A (S35 feed + insights; S36a/b suggestions with drafts + the first guide batch with the four S33 leftovers; S37a/b smart waitlist; S38a/b daily briefing + Phase 8 exit); Phase 8 cap $1.25; BullMQ only for the waitlist, `Periodic` passes for insights and briefing (ADR in S35); insights by deterministic rules, the model writes only drafts, offers start at "ask".
- Tasks: (1) `phase-8-playbook.md` (2) PCR-006 + CHANGELOG 0.31 + roadmap, traceability, dependency-map, jobs and data-model rows (3) user approval (4) `/session-close` (docs-only PR).
- Done: tasks 1–2 (playbook, PCR-006, CHANGELOG 0.31, roadmap/traceability/dependency-map/jobs/data-model rows) · Next: task 3, the user's approval of the playbook and PCR-006; then `/session-close`.

## Last sessions
- **S33 Phase 7f (2026-10-24): Phase 7 exit, merged** ([ADR-0038](../adr/0038-what-i-know-and-the-remembered-chip.md) "S33", [security review](../engineering/security-review-s33.md)). Full entry in [session-log.md](session-log.md).
  - **Built:** guide batch (`find_availability` v2, instructions v5); `alsoAccept` in the grader; pass^3 gates from §2 (with the pass^1 gate on first trials); the business-facts block ≤ 600 tokens as sent; `memory-latency.int.test.ts`; multer, body-parser and nodemailer patched.
  - **Recorded on Luna + Sol:** probe, pass^1 on the rest, pass^3 on 132 cases; $0.3702, Phase 7 $1.2697 of $1.55 (cap raised by the user). Every §2 gate met; one named known miss (`pasted-request-then-book`).
  - **Checks:** `pnpm check` green; `pnpm test:integration` 1,083/1,083; Playwright not re-run (no screen changed); `/code-review` (5 fixed, 4 answered), `/security-review` no findings.
  - **Left for Phase 8:** `pasted-request-then-book` guide fix; `who-works-saturdays` (working hours from a tool); `notBefore` on every day; `lr-blackout` (closures as rules); tenant export (L6), backup retention (L7).
- **S32b Phase 7e "b" half (2026-10-23): the re-record, merged** ([ADR-0038](../adr/0038-what-i-know-and-the-remembered-chip.md) "Results"). Full entry in [session-log.md](session-log.md).
  - **Recorded on Luna + Sol:** probe of memory_write, learned_rules, scheduling and `mr-same-as-last-time` ($0.1116), then all 192 cases at pass^1 ($0.1079), with `--phase-estimate-ok` (user). Every gate met; recall@5 25/25. Phase 7 $0.8994 of $1.00.
  - **Fixed:** the `just-do-it-still-asks` grader (matched "Nothing has been cancelled yet"); `KNOWN_REAL_MODEL_MISSES` empty.
  - **Checks:** `pnpm check` green; `pnpm test:integration` 1,080/1,080; Playwright not re-run (no screen changed since S32a's 82/82).
  - **Left for S33:** held-out misses `in-two-days`, `who-works-saturdays`; the Phase 7 cap for pass^3.

## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Workflow (user, M2):** tests in tiers (full suites once at the end, one at a time); real-model sessions split into "a" (build on the fakes) and "b" (probe, record once, PR); the skills `/session-brief`, `/eval-record`, `/session-close`; short session-log entries.
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, S22):** $5 credit in total for Phase 6 with a hard limit, spent only at the final testing stage (S27); everything before runs on fake providers (playbook §4). S27 spent $0.74 ([ai-budget.md](ai-budget.md)); later phases use the rest under the same policy. **Phase 7 (S28):** at most $1.00 of the rest, recorded per session from S30 on Luna + Sol; the runner enforces it (`--phase 7`).
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S33 (user, 2026-10-24):** at the brief "Go ahead, start with your recommendation": one session; cap option A ($1.40; pass^3 on every set a §2 pass^3 gate names); held-out (a) (`in-two-days` accepts `get_day`, `who-works-saturdays` untuned); `--phase-estimate-ok`. **During the recording:** "Raise the cap to $1.55" (one whole-suite run measured at ≈ $0.197). **After it:** "go with your recommendation": carry `pasted-request-then-book` as a named known miss (its guide fix in Phase 8's first batch) and cap the business block at 600 tokens. **Claude:** the `other-business-bookings` grader corrected; pass^3 gates from §2; `in-three-days` held out in place of `in-two-days` (code review); dependency patches (security review D1–D2).
- **S32b (user, 2026-10-23, Session Brief):** "go ahead with your recommendation": a gate still missing after one fix → ask; S33's pass^3 is a cap decision at its brief; **"Allow, as in S31"** `--phase-estimate-ok` for this session's recordings. **Claude:** the `just-do-it-still-asks` grader corrected where the model was right.
- **S32a (user, 2026-10-23, Session Brief):** "Go ahead with your recommendations, ADR is pre-approved": D-11 over the mock-up (final delete, no Undo); ADR-0038 pre-approved; scripted model only, branch pushed without a PR. **Claude (ADR-0038):** "What I know" from the chat header; 500 facts a page; the chip counts only active facts; `memory-ids.ts` for the chat contract.
- **M2 (user, 2026-10-23, after S31):** asked how to make sessions take less time and fewer tokens without changing how the project runs; approved Claude's plan (test tiers, probe before recording, the three skills, the hook fix, fewer docs); chose the split rule **from S32** (not S33) and the **short** session-log entry. The S32 scope is unchanged, only cut in two.
- **S31 (user, 2026-10-23, Session Brief):** "Go ahead with your recommendations, ADR is pre-approved"; D-1 full re-record at the end and parallel eval runs; D-2 episodes linked to their facts by id; D-3 one per conversation; D-4 forgetting a rule's fact keeps the rule; D-5 rules only from stated preferences; D-6 no episode when nothing is worth remembering. **During the recording:** "Fix + re-record" (memory_write gate), "Estimate guard only" (`--phase-estimate-ok`), "Code fix only" (carry `mr-same-as-last-time`; narrow `remember_fact`'s wording in S32). **Claude (ADR-0037):** the worker imports `@pepper/ai`; a read tool may `prepare` outside the transaction; the remembered rule linked through the receipt; recorded int8 embeddings.
- **S30b (user, 2026-10-23):** record S30 within the $1 cap, fix only what fails, PR and merge. Forget's reworded-value leak: the user chose **"Turn-level + verbatim"** (ADR-0036). **Claude:** runs packed by estimate (guards unchanged); three graders corrected where the model was right; stale S27 trials 2–3 dropped (pass^3 at S33).
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
1. **Before the pilot, at the start of Phase 11 pilot prep (user, S27):** create a free Sentry project and a Grafana Cloud stack (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`). Claude raises it at that brief.
2. **Before the pilot, by hand (S27 security review):** the 5-minute VoiceOver/NVDA check of the streamed chat; confirm the OWASP LLM/Agentic Top 10 2026 titles in the signed-in PDFs on genai.owasp.org; check zero data retention eligibility on the OpenAI account (L2), now also for episodes (S33 review L8); state the backup retention for deleted memory (L7).

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S33 and M2 are done and merged (Phases 0–7). Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S34 | Phase 8 planning (operator feed: insights, daily briefing, suggestions with drafts, smart waitlist): the Phase 8 playbook and PCR, as S28 did for Phase 7; carry the S33 leftovers into its first guide batch | 8a | Playbook and PCR approved by the user |

## How to resume in a new session
Start the session from the latest `main`. Say: *"/session-brief"* (or *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."*). A "b" half's prompt names the "a" branch to merge first. During the session Claude keeps "In progress" current after each finished task; at the end (`/session-close`) it moves that session's summary into "Last sessions", appends a short entry to `session-log.md` and new chat decisions to `decisions.md`, and commits them.
