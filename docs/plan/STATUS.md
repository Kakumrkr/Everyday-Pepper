# Project Status — read this first in every new session

**Last updated:** 2026-10-23 · **Plan version:** 0.29 · **Current phase:** 7 — Memory ([Phase 7 playbook](phase-7-playbook.md), [PCR-005](changes/PCR-005.md)); **S31 done** (episodes and learned rules, recorded on Luna + Sol, [ADR-0037](../adr/0037-episodes-and-learned-rules.md)); **M2 done** (a leaner workflow) → next: **S32a** ("What I know", profile memory, visit notes; built on the fakes)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S32a** ("a" half: scripted model only; push the branch `claude/kind-euler-4ts3n5`, no PR, then give the S32b prompt). Brief approved (user, 2026-10-23): "Go ahead with your recommendations, ADR is pre-approved" → D-11 wins over the mockup (final confirm, no Undo on "What I know"); ADR-0038 pre-approved; if the session runs long, tasks 1–5 done cleanly and the chip polish moves to S32b.
Tasks (each ends with tier 2 + commit + this section updated):
1. [ ] Contracts views + `/v1/memory` API (facts list/edit/delete, own episodes, pause), `no-store`, permissions, isolation case.
2. [ ] Narrow `remember_fact` (drop "closed days and hours too"; staff off/away → `block_time`); scripted cassettes green.
3. [ ] "Memory used" on chat events/history (optional field) + "Remembered" chip in `@pepper/ui` (fix/forget in place).
4. [ ] `/memory` "What I know" page + nav + owner pause switch (mock-up first).
5. [ ] Client profile "What Pepper knows" + visit notes on profile and booking sheet.
6. [ ] Playwright journey: AC-W3-1, AC-W7-2, staff view, pause.
7. [ ] ADR-0038, traceability, memory/area docs.
Next step: task 1.

## Last sessions
- **S31 Phase 7d (2026-10-23): episodes and learned rules, recorded on Luna + Sol, merged** ([ADR-0037](../adr/0037-episodes-and-learned-rules.md), pre-approved). Full entry in [session-log.md](session-log.md).
  - **Built:**
    - the episode job: through the outbox, 30 minutes after a chat's last turn; the routine model writes at most three sentences, which are scrubbed, embedded and stored, one episode per chat. Forgetting a fact deletes the episodes that named it (migration 0042, `fact_ids`); a racing forget makes the job reread;
    - `search_memory`: the member's own top 5, by reference, untrusted;
    - `propose_rule`: the dial action `rule.change`, locked to "ask"; owners and managers only; cuts hours or sets a rule, remembers it as a fact; Undo puts both back;
    - evals: sets `episodic` and `learned_rules`, six more memory_safety cases, `episode_retrieval` (recall@5); every case fails if a rule changed during a member turn; recorded embeddings; cases run four at a time.
  - **Recorded:** all 192 cases, twice (the user's choice after the first pass), **$0.38**; Phase 7 **$0.68 of $1.00**. Fixed from the recordings: "Note that…" went to `propose_rule` (guides), `closed: null` refused (code). `--phase-estimate-ok` for multi-turn cases near the cap (the user's choice).
  - **Gates:** all met but memory_recall 16/17 (`mr-same-as-last-time`, carried by the user's choice, named in the replay test until S32). Episode recall@5 25/25; learned_rules 10/10 with 0 rules without an OK; memory_safety 14/14.
  - **Checks:** `pnpm check` green; `pnpm test:integration` 1,077 green; Playwright 76/76.
- **M2 maintenance (2026-10-23): a leaner workflow, merged** (the user's plan, after S31 ran long). No product code changed. Full entry in [session-log.md](session-log.md).
  - **Tests in tiers** (CLAUDE.md "Running tests"): while building, the changed package's tests and the touched integration files; at each checkpoint, typecheck and lint of what changed; at the end, `pnpm check`, `pnpm test:integration` and Playwright in full, once, one at a time. Same tests, run once instead of three or four times.
  - **Sessions that record the real model are split:** "a" builds on the fakes and pushes its branch, "b" merges it, probes the changed sets, records once and opens the PR. S32 is now S32a + S32b.
  - **Project skills:** `/session-brief` (long docs read by an Explore agent), `/eval-record` (probe, then one full recording; the packing and recording scripts), `/session-close` (the end checks in order, `/code-review`, the docs, one PR; a script for the local Playwright stack).
  - **Docs at the end:** STATUS, plus the ADR, ai-budget, traceability and area docs only when their subject changed; a 5–10 line session-log entry.
  - **Fixed:** the session-start hook now finds this image's headless shell (`chrome-headless-shell-linux64/chrome-headless-shell`), so Playwright gets CI's browser without setting it by hand. ESLint ignores `.claude/**` (session tooling, like `docs/**`).
  - **Checks:** `pnpm lint` and `pnpm format:check` green; the hook run in a clean environment; `pack.mjs` on all, one set and an unknown case; `e2e-stack.sh` up in 8 s, 18 Playwright tests (smoke, auth) green, stopped cleanly; tier-1 commands timed (one integration file 10 s against 245 s for the package).

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
2. **Before the pilot, by hand (S27 security review):** the 5-minute VoiceOver/NVDA check of the streamed chat; confirm the OWASP LLM/Agentic Top 10 2026 titles in the signed-in PDFs on genai.owasp.org; check zero data retention eligibility on the OpenAI account (L2).
3. **Optional:** OpenAI spend so far $1.42 of the $5 credit (S27 $0.74, Phase 7 $0.68 of its $1.00). A full pass^1 re-record now costs about $0.19, so S33's pass^3 (about $0.57) will need a decision on the Phase 7 cap at its brief.

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S31 and M2 are done and merged (Phases 0–6; Phase 7 planning, store, facts in the AI, episodes and learned rules). Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S32a | "What I know", client profile memory and visit notes, "Remembered" chip, pause switch; narrow `remember_fact`'s wording ("Marco is off on Friday" is `block_time`); every eval green on the scripted cassettes; end checks; push the branch, no PR | 7e | AC-W3-1, AC-W7-2 in Playwright (scripted model); `pnpm check` green; integration green except the real-model replay, stale until S32b records |
| S32b | Merge S32a's branch; probe memory_write, learned_rules, scheduling and memory_recall; re-record once; empty the replay test's known misses (`mr-same-as-last-time`); end checks; PR and merge | 7e | Every gate met on the re-record; one green CI run |
| S33 | Full re-record, pass^3, security review, Phase 7 exit | 7f | Playbook §2 met |

## How to resume in a new session
Start the session from the latest `main`. Say: *"/session-brief"* (or *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."*). A "b" half's prompt names the "a" branch to merge first. During the session Claude keeps "In progress" current after each finished task; at the end (`/session-close`) it moves that session's summary into "Last sessions", appends a short entry to `session-log.md` and new chat decisions to `decisions.md`, and commits them.
