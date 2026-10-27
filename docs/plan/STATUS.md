# Project Status — read this first in every new session

**Last updated:** 2026-10-27 · **Plan version:** 0.34 ([PCR-008](changes/PCR-008.md)) · **Current phase:** 9 — New look (S41 done: shell, Home, Chat and the cards on the kit) → next: **S42** (Calendar and Clients on the kit)

**The plan for every session from S39 to launch is the [V1 playbook](v1-playbook.md)** (one row per session, the session standard in §3, skills in §4). Phases end at a [scorecard](scorecard.md) gate. Screens follow [DESIGN.md](../design/DESIGN.md).

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S42 Phase 9 · Calendar and Clients on the kit** (branch `ccr-146c293a-4c46lt`). Brief approved: "Go ahead and start the session with your recommendations" → D-1 A (the screens spec sets the morning hour to a fixed hour already past in the business zone, then polls; no app code), D-2 A (map the stored staff color onto the three staff tokens on the calendar; the Team picker in S42.2).
Tasks: 1 ACs (AC-X-6 widened, AC-X-7 empties with actions, AC-X-8) · 2 the briefing wait in `screens.spec.ts` · 3 Calendar day view on the kit · 4 Clients list + editor · 5 client profile · 6 top-up: tap targets at 375 px + screenshot baselines for Calendar, Clients, profile.
- Done: 1. 2 (`settleBriefing` fixes the hour at 5 or 11 am, then back to the template's 7; ~10 s a test instead of up to 2 min; existing baselines green).
- Next: 3.
- Open questions: none.

## Last sessions
- **S41 Phase 9 · App shell, Home, Chat and the cards on the kit (2026-10-27)** ([ADR-0044](../adr/0044-redesign-and-design-rules.md) S41 note, [DESIGN.md](../design/DESIGN.md)). Full entry in [session-log.md](session-log.md).
  - **Built:** one shell from `lib/nav.ts`: tabs Home, Calendar, Clients, Chat, More on phones; a sidebar with Pepper and Business groups on desktop. `/more` holds the Pepper group, Services, Team, notifications, the mailing address and the account. Home, Chat, Why? and every AI card on the kit; the session-start hook installs Playwright's headless shell 1248.
  - **Top-up (S40 retro):** `tap-targets.ts` checks every control is ≥ 44 px on the shell and Home at 375 px (it found a 17 px link).
  - **Checks:** `pnpm check` green; integration 1,239 passed in one run; Playwright 110 passed, 16 skipped (the mobile copies of desktop-only specs); 18 new screenshot baselines (Home, Chat, More × 375/412/1280 × light/dark).
- **S40 Phase 9 · Foundation (2026-10-27): the A+B tokens, the kit, the gallery, the design lint and screenshot tests** ([ADR-0044](../adr/0044-redesign-and-design-rules.md) "Built", [DESIGN.md](../design/DESIGN.md)). Full entry in [session-log.md](session-log.md).
  - **Built:** `tokens.ts`/`theme.css` from DESIGN §3 (old names kept as Tailwind aliases until S43, `LegacyCard`); 27 components in `packages/ui/src/kit/` (Radix dialog/tabs/toggle-group/toast); `/dev/gallery` on Southside Cuts' data behind `PEPPER_GALLERY=1` (the top-up); the raw color/duration lint; 8 Linux screenshot baselines with axe.
  - **Checks:** `pnpm check` green; integration green (two known load misses passed alone); Playwright 105/105; every existing screen now in plum and marigold, axe clean.
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
- **Design (user, P1, S39):** a complete redesign in Phase 9 (ADR-0044); direction **A+B** chosen in S39 (warm boutique colors and type, clean premium's lists and tables); tokens, type scale and components in [DESIGN.md](../design/DESIGN.md) §2–4; rules enforced by lint, contrast and screenshot tests. S40 shipped them (ADR-0044 "Built"); screens move onto the kit in S41–S43.
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
Older ones (S25–S33) are in [decisions.md](decisions.md).
- **After S41 (user, 2026-10-27):** faster sessions ([PCR-008](changes/PCR-008.md)): review before checks, each suite once, integration only when its code changed, the walkthrough from the screenshot baselines, sessions sized to one context window (S42 split into S42 + S42.2). Full wording in [decisions.md](decisions.md).
- **S41 (user, 2026-10-27):** at the brief "Go ahead with your recommendations": D-1 a More tab on phones (Pepper group, then Services, Team, account); the desktop sidebar shows everything; D-2 Home's settings move to More (Home keeps an "Add your address" line); D-3 the hook installs the headless shell Playwright expects. **Claude:** the code review's 7 fixes, 2 left with reasons (session log).
- **S40 (user, 2026-10-27):** at the brief "Go ahead start with your recommendation": D-1 DESIGN token names with the old names as aliases until S43; D-2 Radix dialog, tabs, toggle-group and toast in `packages/ui`; D-3 the gallery behind `PEPPER_GALLERY=1`, 404 otherwise; D-4 Linux baselines made in the session with CI's headless shell, 1% tolerance. Then "continue and complete the session close". **Claude (ADR-0044 Built):** Select, Checkbox and Switch native; the old `Card` renamed `LegacyCard`; the review's eight fixes.
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
S1–S41, M1–M2 and P1 are done (Phases 0–8, the re-plan, and Phase 9's direction, foundation, shell, Home and Chat). Each row's tasks, skills and gates are in the [V1 playbook](v1-playbook.md) §5; the brief reads them from there.

| # | Session target | Phase | Done when |
|---|---|---|---|
| S42 | Calendar (day view) and Clients (list, profile) on the kit | 9 | Calendar and Clients on the kit; journeys + screenshots green |
| S42.2 | Services, Team, Autonomy, What I know, Waitlist on the kit (split from S42, PCR-008) | 9 | Every signed-in screen on the kit |
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
