# Project Status — read this first in every new session

**Last updated:** 2026-10-26 · **Plan version:** 0.33 ([PCR-007](changes/PCR-007.md)) · **Current phase:** 9 — New look (S39 done: direction A+B) → next: **S40** (Foundation: tokens, fonts, component kit)

**The plan for every session from S39 to launch is the [V1 playbook](v1-playbook.md)** (one row per session, the session standard in §3, skills in §4). Phases end at a [scorecard](scorecard.md) gate. Screens follow [DESIGN.md](../design/DESIGN.md).

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S40 Phase 9 · Foundation** (branch `claude/s40-design-foundation`). Brief approved 2026-10-27: "Go ahead start with your recommendation" (D-1 A: DESIGN token names, old names kept as aliases until S43, `s1`–`s3` dropped; D-2 Radix primitives into `packages/ui`; D-3 A: gallery behind `PEPPER_GALLERY=1`, 404 otherwise; D-4 baselines made here with CI's headless shell, small tolerance).
Tasks: 1 AC-X-4 + traceability ✅ · 2 tokens/theme + 3:1 check ✅ · 3 raw-color/duration lint ✅ · 4 kit: controls ✅ · 5 kit: content blocks · 6 kit: Radix pieces · 7 gallery (Southside Cuts data, top-up) · 8 gallery screenshots 3 widths × 2 themes + axe · 9 docs, `/session-close`.
Next step: task 5 (kit: content blocks). Old `Card` is now `LegacyCard` (15 screens); kit files in `packages/ui/src/kit/`. Lint: `packages/config/eslint-design.js` (+ node:test), merged into the one `no-restricted-syntax` list in eslint.config.js. Note: the old names live on only as Tailwind aliases (`--color-on-brand` etc.); raw `var(--on-brand)` no longer exists, so legacy CSS uses the new names.

## Last sessions
- **S39 Phase 9 · design direction (2026-10-26): the user chose "A+B"; docs and mockups only** ([ADR-0044](../adr/0044-redesign-and-design-rules.md) Direction, [DESIGN.md](../design/DESIGN.md) §2–4, [mockups](../mockups/s39/README.md)). Full entry in [session-log.md](session-log.md).
  - **Built:** a clickable canvas (https://claude.ai/artifact/QCiTKo7b95kE6MAtXjNQCY, private): A warm boutique, B clean premium, C bold modern, then the A+B mix, five phone screens each plus dark, on one made-up barbershop with numbers that add up (the P1 top-up).
  - **Chosen:** A's colors (plum + marigold on warm off-white), Bricolage Grotesque + Figtree, pills, briefing block and sheets; B's hairline lists, one big number per screen, the approval detail table, the booking step bar and sticky action bar. A raised card means "this needs you".
  - **Checks:** the contrast check passes for every pair in both themes; `pnpm check` green; no code changed, so integration and Playwright were not run.
- **P1 V1 re-plan (2026-10-26): planning only, no product code** ([PCR-007](changes/PCR-007.md), [V1 playbook](v1-playbook.md), [scorecard](scorecard.md), [ADR-0043](../adr/0043-card-board-first-interaction.md), [ADR-0044](../adr/0044-redesign-and-design-rules.md), [DESIGN.md](../design/DESIGN.md)). Full entry in [session-log.md](session-log.md).
  - **Why:** the user's launch-readiness review (private) scored 1–8/10 per category: a strong AI layer on a thin foundation. P1 checked every claim against the code; all held.
  - **How:** grilling rounds over the review and five *simulated* owner interviews ([readout](../research/interviews/2026-10-26-simulated-five-owners.md), hypotheses only), decisions P1-1…P1-12 (playbook §2).
  - **Result:** Phases 9–17, S39–S76: a new look first, then setup, import and privacy, the card-board employee, pilot readiness, the pilot, SMS, deposits, calendar, the launch gate. SMS and deposits in V1; AI budget $10 for V1; the session standard (walkthrough, top-up, retro, scorecard gates); `/session-brief` and `/session-close` updated.
  - **Branches:** the four leftover "a" branches (S32a, S36a, S37a, S38a) were checked: each is contained in its merged "b" PR (#41, #45, #46, #47). The user deletes them by hand on GitHub: sessions can't delete other branches (403). `/session-close` now checks the "a" branch and asks the user to delete it.
## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Session standard (user, P1):** the M2 workflow plus playbook §3: owner value first, a scorecard gate per phase, a product walkthrough at every close (375 px, light and dark, screenshots in the PR), one top-up per session and a three-line retro carried into the next prompt, skills by kind of session (playbook §4).
- **Product (user, P1):** first customer 1–6 chair owner-operators (barber, hair, lash/brow, nails); cards first, chat second (ADR-0043); SMS and deposits in V1; branded booking page in V1, layouts in V1.1, own-domain site after PMF; the pilot starts after Phase 13, email only.
- **Workflow (user, M2):** tests in tiers (full suites once at the end, one at a time); real-model sessions split into "a" (build on the fakes) and "b" (probe, record once, PR); the skills `/session-brief`, `/eval-record`, `/session-close`; short session-log entries.
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, P1):** **$10 for Phases 9–17** on top of the $3.80 spent through Phase 8 (caps: Phase 12 $3.00, Phase 17 $1.50, reserve $5.50; no real calls elsewhere). Development evals on a separate `pepper-dev-evals` project with data sharing on (free daily tokens, made-up data only); production on a sharing-off, zero-retention project. The runner's $4.50 total stop rises to $13.80 in S56a. History of earlier caps: [ai-budget.md](ai-budget.md), [decisions.md](decisions.md).
- **Brand, LLC and domain parked (user, P1):** the name can change later; a cheap neutral domain for the pilot in Phase 13; the LLC before SMS and Stripe go live (both are built in sandbox first).
- **Design (user, P1, S39):** a complete redesign in Phase 9 (ADR-0044); direction **A+B** chosen in S39 (warm boutique colors and type, clean premium's lists and tables); tokens, type scale and components in [DESIGN.md](../design/DESIGN.md) §2–4; rules enforced by lint, contrast and screenshot tests. Until S40 ships them, the current tokens (PCR-002) stay.
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
Older ones (S25–S33) are in [decisions.md](decisions.md).
- **S39 (user, 2026-10-26):** at the brief "go ahead with your recommendations" (one canvas, Google Fonts in mockups only); "what is your rec?" → Claude: A as the base with B's calm; "sure" to an A+B row; **"go with A+B"**. PCR-002's colors are superseded from S40 (ADR-0044).
- **P1 (user, 2026-10-26):** planning only, no S39 work. Grill Me installed (the `grilling` skill). Decisions P1-1…P1-12 in the [V1 playbook](v1-playbook.md) §2: staged 10/10 with "what 10 looks like" lines; five interviews as reference (the shared ones are simulated); SMS and deposits into V1; brand/LLC/domain parked; data-sharing dev-evals project and a **$10** V1 cap ("max 10 bucks"); the 1–6 chair segment, cards first and the booking-page/website staging; pilot after Phase 13 with a neutral domain; a complete redesign first, warm-boutique + clean-premium (dislikes: bland, template-like, not premium); smart deposits; approve by text. "Plan it properly by preserving the original working flow", "raise the PR and merge the plan". After P1: imports from an owner's own app via CSV/JSON exports, with direct database connections after V1 (P1-13); UI UX Pro Max beside frontend-design (P1-14: "include both… my goal is a better product").
- **S38b (user, 2026-10-25):** at the brief "Go with your recommendations". During the recording: "Allow for S38b" (`--phase-estimate-ok`); "Fix, cap $2.00" (the `add_to_waitlist` guide fix and a second full re-record; Phase 8 cap $1.75 → $2.00); "Carry to Phase 9" (`wl-add-marco-saturday`, `wl-staff-own-client` named known misses; Phase 9's first session moves the full-window check into the domain); "Allow, these runs only" (`--max-cost 2` for single-case pass^3 runs over the $1.50 guard); "Extend the flag" (`--phase-estimate-ok` passes the $4.50 stop's estimate). **Claude:** cases fitted where the model was right (`tool-create-booking-1`, `tool-get-feed-4`, `wl-staff-colleague-refused`); three security tests for controls without one; low findings L9–L14 logged.
- **S38a (user, 2026-10-25):** at the brief "Go with your recommendations": the Phase 8 cap rises to $1.75; ADR-0042 pre-approved. **Claude (ADR-0042):** a `daily_briefing` kind; the hour a business setting over the template's, shared with the drafts pass; the briefing runs while paused; the public waitlist through the booking code's flow; the code review's 8 fixes.
- **S37b (user, 2026-10-24):** at the brief "Go with your recommendations". During the recording: "Allow for S37b" (`--phase-estimate-ok` for the full recording); "Carry to S38" (`move-done-no-approval-talk` named in `KNOWN_REAL_MODEL_MISSES`; S38a adds a `find_availability` guide line, S38b's re-record must clear it); "Decide at the S38a brief" (the Phase 8 cap for S38b's re-record and pass^3). **Claude:** the waitlist cases corrected where the model was right (free times, two Saras, a client staff can't see); S36b's stale pass^3 trials 2–3 of 7 chat cases dropped; the code review's duplication finding left (ADR-0041 results).
- **S37a (user, 2026-10-24):** at the brief "Just go with your recommendations and complete the job. Don't wait for me"; keep S37b's recording small. Taken: D-1 offers follow the dial (default ask), D-2 the 2-minute clock ends at the offer made, D-3 a `waitlist_matches` table, D-4 no guide changes (moot), D-5 ADR-0041 pre-approved. **Claude (ADR-0041):** lexicographic ranking, no template weights; clients without an email not offered; `MAX_CASES_PER_RUN` 20 → 18 (21 tools broke the $1.50 run cap's worst case); the `waitlist_match` feed item and "Join the waitlist" on the booking page deferred to S38a.
- **S36b (user, 2026-10-24):** at the brief "Go ahead with your recommendations" (D-1 A pass^3 only where §2 names it for S36; D-2 A seven more cases; D-3 ask after one failed fix). During the recording: "Record again" (second full recording), "Second fix, then record" (team to-dos), "Allow, these 7 only" (`--phase-estimate-ok` for 7 chat cases' pass^3). **Claude:** graders corrected where the model was right; transport failures re-run; the code review's findings fixed in this PR.
- **S36a (user, 2026-10-24):** at the brief "Go ahead, start with the recommendation and complete the tasks": D-1 A (a morning drafts pass once a day per business at the template's hour, which S38's briefing will call); D-2 A (the postal address in settings, no nudge until it is set); D-3 owners and managers approve nudges; D-4 ADR-0040 pre-approved. **Claude (ADR-0040):** a pass's proposals belong to the business (`requestedBy` null, audited as system) and always ask; edits re-fingerprint through `reviseProposal`; any earlier nudge in the interval (sent, refused or expired) blocks another; opt-out stops nudges only.
- **S35 (user, 2026-10-24):** at the brief "Go ahead with your recommendations, ADR is pre-approved" (D-1 re-run via a request row + 1-minute `Periodic` pass; D-2 thresholds; D-3 audience; D-4 Needs your OK / Done from proposals and receipts; D-5 `feed_settings` with ask-once; D-6 ADR-0039). Later "complete all tasks don't have to ask, go with recommendation". **Claude (ADR-0039):** `services.rebook_after_days`; `apps/worker` may import templates; append-only `insight_requests` + advisory lock (after a timestamp version lost a request and a counter row was a hot lock); hours/time-off changes also re-run; dismissed items come back after the snooze.
- **S34 (user, 2026-10-24):** at the brief "Go ahead with your recommendations": layout A (S35; S36a/b; S37a/b; S38a/b), Phase 8 cap $1.25, BullMQ only for the waitlist with `Periodic` passes for insights and the morning run, insights by rules and only drafts by the model, waitlist offers start at "ask". Then "approved, go ahead with /session-close": the playbook and PCR-006 with the review's additions (one-click unsubscribe for nudges, `add_to_waitlist` + dial action `waitlist.change`, offers to the top 3, a template-written briefing without email, `staff_overload`, snooze and "Pause suggestions").

## Waiting on the user
Raised by Claude at the brief of the session named.
1. **During Phase 10 (S45 brief):** start Google's OAuth verification for the Calendar scopes (it takes weeks; needed in S70).
2. **Before S56b:** create the two OpenAI projects (`pepper-dev-evals` with data sharing on, production with sharing off), check the free daily token limits on the dashboard (Data Controls → Sharing), and set the hard limit to the $10 V1 budget.
3. **By S57 (Phase 13):** buy a cheap neutral domain for the pilot; create a free Sentry project and a Grafana Cloud stack (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`).
4. **Before the pilot (S60), by hand:** the 5-minute VoiceOver/NVDA check; a push test on a real iPhone; confirm the OWASP LLM/Agentic Top 10 2026 titles; zero data retention on the production OpenAI project (L2, L8); the backup retention for deleted memory (L7); 3–5 pilot owners from the target segment.
5. **Before SMS and Stripe go live (Phases 14–15):** form the LLC, register 10DLC (4–8 weeks), open the Stripe account (test mode needs only a sign-up, from S65).

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S39, M1–M2 and P1 are done (Phases 0–8, the re-plan, and Phase 9's design direction). Each row's tasks, skills and gates are in the [V1 playbook](v1-playbook.md) §5; the brief reads them from there.

| # | Session target | Phase | Done when |
|---|---|---|---|
| S40 | Foundation: new tokens, fonts, component kit, gallery, raw-color lint, screenshot tests | 9 | Theme/contrast tests and gallery baselines green |
| S41 | App shell + navigation (More tab, Pepper group), Home, Chat and the cards on the kit | 9 | Those screens on the kit; journeys + screenshots green |
| S42 | Calendar, Clients, Services, Team, Autonomy, What I know, Waitlist on the kit | 9 | Every signed-in screen on the kit |
| S43 | Public pages + auth on the kit, legacy stylesheet deleted, UX copy pass, **Phase 9 gate** | 9 | Scorecard C3, C4, C10 ≥ 8 |
| S44 | Password reset, email verification, change email; `add_to_waitlist` window check in the domain | 10 | Journeys + domain tests green |
| S45 | Business type at signup → pre-filled menu and hours; US zones first; activation events | 10 | A barber business bookable with zero typing |
| S46 | Setup checklist + warnings; staff without hours hidden; first free day; plain zone names | 10 | Review UX #1–#5 closed with tests |
| S47 | Branded booking page (profile, images, colors), remembered devices, drop-off per step; **Phase 10 gate** | 10 | New owner bookable < 10 min |
| S48 | Client import: CSV, JSON or JSONL (five tools, generic, or an own app's export), smart mapping, preview, dedupe, undo by batch | 11 | AC-W1-3; no duplicates on re-import |
| S49 | History + upcoming appointments import; tags, birthdays | 11 | 1,000 clients / 5,000 visits < 2 min |
| S50 | Client merge, delete, staff walk-ins, paging and search | 11 | Playwright; isolation suite 100% |
| S51 | Export, account + business deletion, terms/privacy drafts; **Phase 11 gate** | 11 | Export round-trips; C11, C13 ≥ 8 |
| S52 | Home card board (ranked by $, grouped, quiet start) + activity log | 12 | Grouped feed; every AI action in the log |
| S53 | Autonomy presets, standing rules, client-visible moves ask, earned trust | 12 | Preset/rule tests; move card names the email |
| S54 | Cancellation → fill with receipts, win-back list, the post-import aha | 12 | Offer < 2 min p95; 0 wrong sends |
| S55 | Weekly value card, evening wrap, review requests | 12 | Numbers equal fixture sums; caps tested |
| S56a | `send_client_message`, `mark_no_show`, AI-suggested import mapping, prompt fixes, new eval cases; scripted ("a") | 12 | Every eval set green on scripted cassettes |
| S56b | Record ("b", $3.00 cap), `KNOWN_REAL_MODEL_MISSES` empty; **Phase 12 gate**; one PR | 12 | Every gate met; C1, C5 ≥ 8, C8 ≥ 9 |
| S57 | Deploy: VPS, neutral domain, TLS, Resend + SPF/DKIM/DMARC, runbook | 13 | Mail-tester ≥ 9/10; HTTPS live |
| S58 | Backups + restore drill, Sentry/Grafana, Redis rate limits, load test | 13 | Restore drill passes; SLOs met |
| S59 | Support button, help page, terms + privacy, AI disclosure, pilot metrics page | 13 | Every metric has a number |
| S60 | Security review, manual checks, **pilot gate** → 🚦 pilot starts | 13 | Scorecard pilot column met |
| S61 | SMS channel: adapter, consent, STOP/HELP, quiet hours, sandbox | 14 | Contract tests; STOP < 1 min |
| S62 | SMS reminders (incl. < 24 h bookings), confirm by text | 14 | Timing + idempotency tests |
| S63 | Approve by text (signed single-use codes) | 14 | Replay and spoof tests |
| S64 | SMS live after 10DLC; **Phase 14 gate** | 14 | C12 ≥ 7 |
| S65 | Stripe Connect Express onboarding, idempotent webhooks | 15 | Webhook replay/signature tests |
| S66 | Deposits + card on file, Stripe-hosted fields, refunds | 15 | Test-mode pay/cancel/refund journeys |
| S67 | Smart deposits + cancellation-policy builder | 15 | Rule fixtures; policy in every channel |
| S68 | No-show fee by approval card; **Phase 15 gate** | 15 | No charge without approval; C12 ≥ 8 |
| S69 | Week view + drag to move | 16 | Drag journeys; double-booking check |
| S70 | Google Calendar in (busy blocks) | 16 | Contract + token-expiry tests |
| S71 | Google Calendar out, incremental sync | 16 | Conflict + duplicate scenarios |
| S72 | Recurring appointments, staff week; **Phase 16 gate** | 16 | Recurrence property tests; C6 ≥ 8 |
| S73 | Reports (five numbers) | 17 | Numbers equal fixture sums |
| S74 | Pepper billing: plans, 30-day trial, dunning | 17 | Test-mode billing journeys |
| S75 | Landing page + pricing | 17 | Lighthouse ≥ 95 mobile |
| S76 | Final re-record ($1.50), security review, **launch gate** | 17 | Every category ≥ 9; go/no-go |

## How to resume in a new session
Start the session from the latest `main`. Say: *"/session-brief"*. The brief reads this file and the session's playbook row, names the skills and the top-up, and carries the last retro. (or *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."*). A "b" half's prompt names the "a" branch to merge first. During the session Claude keeps "In progress" current after each finished task; at the end (`/session-close`) it moves that session's summary into "Last sessions", appends a short entry to `session-log.md` and new chat decisions to `decisions.md`, and commits them.
