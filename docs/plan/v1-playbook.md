# V1 Playbook: from Phase 8 to paid launch (Phases 9–17)

Plan version **0.33** ([PCR-007](changes/PCR-007.md), approved by the user in planning session P1, 2026-10-26). This file replaces the old Phase 9–11 rows of [roadmap-phases.md](roadmap-phases.md) with nine phases and one row per session. Every future session takes its target, tasks and "done when" from here, through STATUS "Planned sessions" and `/session-brief`.

The scorecard the phases are judged by is [scorecard.md](scorecard.md). The design rules every screen follows are [DESIGN.md](../design/DESIGN.md).

## 1. Why the plan changed

38 sessions built a pilot-grade **AI and trust layer** (cards, autonomy, undo, memory, feed, waitlist, evals at 100% on the safety sets) on a **thin business foundation**: an empty start, no import, no password reset, email only, no deposits, no deploy. An outside launch-readiness review (2026-10-25, the user's private notes, not in the repo) scored the product at 1–8 out of 10 per category, with switching value at 2 and market competitiveness at 3. Every finding it made was checked against the code in P1 and held.

Two more inputs shaped the plan:
- **Five simulated owner interviews** ([interviews/2026-10-26-simulated-five-owners.md](../research/interviews/2026-10-26-simulated-five-owners.md)). They are role-played and give **hypotheses, not evidence**. The pilot measures each one (§6).
- **The user's goals:** every category reaches 10, and Pepper offers everything owners rely on in competitors' tools **plus** things no competitor does.

## 2. Product decisions (P1, user)

| # | Decision |
|---|---|
| P1-1 | **10/10 is staged.** Each category has a "what 8, 9 and 10 look like" line ([scorecard.md](scorecard.md)). The pilot gate needs ≥ 8 (two named exceptions), the launch gate ≥ 9. A 10 is earned with pilot results, not by finishing a build. |
| P1-2 | **Interviews are a reference, building does not wait.** The simulated readout guides priorities. Pilot measurements decide. |
| P1-3 | **First customer:** owner-operators with 1–6 chairs: **barbers, hair stylists, lash/brow and nails**. Booth-rental shops (one calendar per renter) and clinical skin/med-spa come after V1. All 8 templates stay, but setup and the pilot focus on these four types. |
| P1-4 | **Cards first, chat second** ([ADR-0043](../adr/0043-card-board-first-interaction.md)). Home becomes a daily card board ranked by dollars. Standing rules mean most cards never appear. A plain-language activity log records everything. Chat stays, as an optional extra. Positioning: *"The front-desk employee that keeps your chair full. Approve with one tap, undo anything."* |
| P1-5 | **SMS and deposits move into V1** (from V1.1). Both are built in sandbox or test mode first and go live once a business entity exists (10DLC registration, a Stripe account). |
| P1-6 | **Brand, LLC and domain are parked.** The name can change later. Phase 13 buys a cheap neutral domain for the pilot's sending address. |
| P1-7 | **AI budget: $10 for Phases 9–17**, on top of the $3.80 already spent. Development evals run on a separate OpenAI project with data sharing on (free daily tokens), using made-up data only. The production project keeps sharing off and gets zero data retention ([ai-budget.md](ai-budget.md)). |
| P1-8 | **Booking page and website staging:** V1 gets a branded booking page (logo, cover, gallery, colors, phone, address, policy). V1.1 gets 3–5 booking-page layouts (the user's template idea). After PMF: a mini-website on the owner's own domain (the user's website idea). |
| P1-9 | **The pilot starts after Phase 13, with email only.** SMS and deposits are built during the pilot. |
| P1-10 | **A complete redesign comes first** (Phase 9, [ADR-0044](../adr/0044-redesign-and-design-rules.md)), so every new screen is built in the new look. Direction: warm-boutique and clean-premium side by side, bold as the third mockup option. The user dislikes the current look as bland, template-like and not premium. |
| P1-11 | **Smart deposits:** deposits only from new clients and clients with a no-show history. Regulars in good standing are exempt automatically, and the owner can adjust the rule (Phase 15). |
| P1-12 | **Approve by text:** Pepper texts the owner a card summary ("Reply Y") over the SMS channel (Phase 14). The full two-way chat by text stays in V1.1. |
| P1-13 | **Import from an owner's own app** (user, after P1): any app's database can be exported, so the importer takes **CSV, JSON and JSONL** exports with flexible column mapping (S48). Pepper suggests the mapping from header names and value patterns. An AI suggestion for the columns those miss comes in S56a and is recorded in S56b. The model sees column names and masked samples only, and the owner confirms. **Direct database connections** (Postgres, AWS RDS, MongoDB Atlas) are not in V1: Pepper would hold a password to the owner's system. After V1 they're offered as a one-time, read-only "we move you" migration run with the owner, with no credentials stored. |
| P1-14 | **Design skills** (user, after P1): **UI UX Pro Max** (community, MIT) proposes candidate design systems and supplies UX and accessibility checklists. **frontend-design** makes the screens distinctive. [DESIGN.md](../design/DESIGN.md) and its tests decide over both. A third-party skill is read through before its first use. UI UX Pro Max is vendored as a project skill (`.claude/skills/ui-ux-pro-max`, upstream commit `28b3b8d`, MIT, reviewed in P1), so every session has it; its Pepper note forbids `--persist`. frontend-design and the Design plugin are installed on the user's account. |

## 3. How every session works from S39 (the session standard)

The M2 workflow is unchanged: `/session-brief` → approval → tasks with tiered tests → `/session-close`; one feature-sized goal; "a"/"b" halves when the real model is recorded; one PR and one CI run. P1 adds five rules on top:

1. **Owner value first.** Every session ships something an owner, staff member or client can see or feel, or it is a named enabler of the next one ("foundation for S41").
2. **A scorecard gate at every phase end.** The phase's last session scores each category against [scorecard.md](scorecard.md), with evidence. A phase isn't done below its target.
3. **A product walkthrough at every close.** `/session-close` looks at the changed screens' screenshot baselines (375/412/1280 px, light and dark) and walks one changed flow as the person who uses it, on a 375 px phone (screenshots into the PR; PCR-008). Green tests are necessary, not sufficient.
4. **Raise the bar.** The brief proposes one **top-up**: a small extra inside the session's area that moves a scorecard line towards 10 (copy, an empty state, an edge case, a speed-up). The close writes a three-line **retro** (what went well, what to do better, the top-up for the next session), and the next prompt carries it.
5. **The right skills for the work** (§4), and design rules enforced by tests ([DESIGN.md](../design/DESIGN.md) §5).

## 4. Skills by kind of session

The brief names the skills for the session; a skill that isn't installed in a session is skipped, never faked.

| Kind | Skills |
|---|---|
| Every session | `/session-brief`, `/session-close`, `/code-review`; `/security-review` when auth, tenancy, tool arguments, payments, messaging or outside text are touched |
| UI and design | `frontend-design` (distinctive screens), `ui-ux-pro-max` (candidate design systems for the industry; UX and accessibility checklists), the Design plugin (`design-critique`, `design-system`, `ux-copy`, `accessibility-review`), `artifact-design` (clickable mockups), `run` (see it in the app) |
| Domain and backend | `tdd` (test first), `codebase-design` (module seams), `diagnosing-bugs` |
| AI | `/eval-record` ("b" halves only) |
| Planning and hard choices | `grilling` (decision rounds with recommendations) |

## 5. Phases and sessions

Each row: target · what is built · done when. "Rec" marks the only sessions that call the real model.

### Phase 9 · New look (S39–S43, with S42.2)
Goal: Pepper looks premium, warm and distinctly its own on every screen, and the design rules are enforced by tests. Scorecard target at exit: friendly UX 8, mobile 8, accessibility 8.

| # | Target | Built | Done when |
|---|---|---|---|
| S39 | **Design direction** | Three clickable phone mockups of the same 5 screens (Home card board, Calendar, Client, booking page, an approval card), as artifacts the user opens on the phone. Directions: warm-boutique, clean-premium, bold. `ui-ux-pro-max` proposes candidate systems for "barber / salon / beauty", and `frontend-design` makes each direction distinctive. The user picks one or mixes them. The pick is written into DESIGN.md §2–4 and ADR-0044 "Direction". No app code. | The user approves one direction; DESIGN.md has its tokens, type scale and component list |
| S40 | **Foundation** | New `tokens.ts` / `theme.css` (color, type scale, spacing, radius, elevation, motion), fonts, and the component kit in `packages/ui` (Button, IconButton, Input, Select, Sheet, Dialog, Tabs, Card, ListRow, Badge, EmptyState, Skeleton, Toast). A dev-only gallery route. The lint rule against raw colors. Screenshot tests of the gallery at 375 / 412 / 1280 px, light and dark. | Theme and contrast tests green; gallery screenshots committed as baselines; no raw color in `packages/ui` |
| S41 | **App shell, navigation, Home and Chat** | New shell: bottom tabs Home · Calendar · Clients · Chat · More; desktop sidebar with a "Pepper" group (What I know, Autonomy, Waitlist). Home, Chat and every card (`packages/ui/cards`, feed) on the new kit. | Those screens on the kit; Playwright journeys green; screenshots at 3 widths × 2 themes |
| S42 | **Calendar and Clients** | Calendar day view, Clients list and profile on the new kit; every empty state says what to do next. Split from one seven-screen session (PCR-008). | Calendar and Clients on the kit; journeys + screenshots green |
| S42.2 | **Settings screens** | Services, Team, Autonomy, What I know, Waitlist on the new kit; every empty state says what to do next. | Every signed-in screen on the kit |
| S43 | **Public pages, auth and the phase gate** | Booking page, manage-booking, sign-in, sign-up, MFA, create business on the kit; the legacy stylesheet deleted; UX copy pass; the Phase 9 scorecard. | Legacy stylesheet gone; axe clean; scorecard targets met |

### Phase 10 · First 10 minutes (S44–S47)
Goal: a new owner can take bookings in under 10 minutes, and never hits a dead end. Exit: core usefulness 6, realism 6, owner experience 7, customer booking 7.

| # | Target | Built | Done when |
|---|---|---|---|
| S44 | **Account recovery + the waitlist fix** | Password reset and email verification (Better Auth, through the outbox), change email; `requireEmailVerification` on for new accounts. `add_to_waitlist` checks its windows in the domain (the two named known misses; recorded in S56b). | Reset, verify and change-email journeys in Playwright; the domain check's tests green |
| S45 | **Business type at signup** | Pick a type (barber, hair, nails, lash/brow first; the other templates under "More types"), which pre-fills services, prices, durations and hours from the template, all editable. `tenants.template_id` set. US time zones first, defaulting from the browser. **Activation events** (signup, bookable, first booking), no personal data. | A new barber business is bookable with zero typing; events recorded |
| S46 | **Setup checklist and warnings** | A Home checklist until the business is bookable. Warnings for a service no one offers, staff without hours, and a booking page that isn't taking bookings. Staff without hours are hidden from the booking page. The time step opens on the first free day, with plain zone names ("Central Time"). | Every dead end in the review's UX table #1–#5 closed, each with a test |
| S47 | **Branded booking page** | Business profile (phone, address, cancellation policy), logo, cover photo and a gallery of their work (uploads to S3-compatible storage, SeaweedFS in dev; type, size and dimension checks; resized server-side), brand colors. Returning devices skip the email code; drop-off per booking step recorded. Phase gate. | A scripted new-owner journey is bookable in < 10 minutes; the booking page shows contact details |

### Phase 11 · Switching + privacy (S48–S51)
Goal: an owner can move in from Square, Booksy, Vagaro, GlossGenius or Fresha without retyping, and can leave with everything. Exit: switching value 8, security and privacy 8.

| # | Target | Built | Done when |
|---|---|---|---|
| S48 | **Client import** | Upload of **CSV, JSON or JSONL** (the five tools' exports, or any app's own database export) with mapping presets for the five tools, smart mapping for anything else (header names and value patterns: phones, emails, dates), preview, validation with reasons per row, duplicate matching and merge, a worker job, and **undo the whole import** (batch id). AC-W1-3. | Fixtures in each tool's export format import cleanly; re-import creates no duplicates |
| S49 | **History import** | Past visits (visit history Pepper and the AI can use) and upcoming appointments, conflicts listed, never an email on import. Client tags and birthdays. | A 1,000-client, 5,000-visit file imports in < 2 minutes with correct counts |
| S50 | **Client lifecycle** | Merge two clients, delete a client (memory scrubbed, audited), staff add a walk-in client (privacy rules kept), client list paging and search past 50. | Each in Playwright; the isolation suite at 100% |
| S51 | **Export and deletion** | Full business export (a ZIP of CSV and JSON), account deletion and business deletion with a grace period and scrub; terms and privacy policy drafted (docs, reviewed in S59). Phase gate. | Export round-trips through import; deletion leaves no tenant rows |

### Phase 12 · The employee (S52–S56b)
Goal: Pepper fills the chair and proves it in dollars, with the owner tapping instead of typing. Exit: owner experience 8, AI trust 9, core usefulness 8.

| # | Target | Built | Done when |
|---|---|---|---|
| S52 | **Home card board + activity log** | Home as the daily board ([ADR-0043](../adr/0043-card-board-first-interaction.md)): the briefing on top, cards ranked by dollars, similar cards grouped, quiet until there is booking history. An activity log screen in plain language (from the audit log and executions). | The review's feed-noise case is one grouped card; the log shows every AI action |
| S53 | **Trust controls** | Autonomy presets (Careful, Balanced, Hands-off) with "Customise" for the 13 actions. Standing rules in plain words, mapped to the dial and booking rules. Client-visible moves default to "ask", and the card says who gets an email. Earned trust: after 20 correct actions of one kind, Pepper offers to do that kind alone. | Preset and rule tests; the move card names the email |
| S54 | **The money loop** | Cancellation → fill: waitlist and overdue regulars ranked, the offer drafted, sent per the dial or a standing rule, then a receipt ("Filled Tue 2 pm, +$60"). The win-back list ("haven't been back") with one-tap drafts. The first-session aha after import ("12 regulars are overdue, about $540"). | A cancelled slot is offered in < 2 minutes p95; 0 wrong-client sends in the race and fixture tests |
| S55 | **Proof of value** | The weekly "what Pepper did for you" card (visits booked, gaps filled, regulars back, dollars, minutes saved) and the evening wrap ("tomorrow: 7 visits, 1 at risk"). Post-visit review requests (owner-approved, at most one per client per 90 days). | Card numbers equal the fixture sums; caps tested |
| S56a | **AI tools and polish ("a")** | `send_client_message` (reminder, running late, a custom note; outbox; "ask" by default) and `mark_no_show`; the prompt's "in Settings" line fixed; guess-and-confirm for typos; honest "I can't do that yet, here's what happens instead". AI-suggested import mapping for columns S48's smart mapping misses (column names and masked samples only, owner confirms). New eval cases: one-sentence move ≥ 98%, mapping suggestions. Scripted model only. Raise the runner's total stop to the new budget. | Every eval set green on the scripted cassettes |
| S56b | **Record ("b") + phase gate** — Rec | Merge S56a, probe the changed sets, record once, pass^3 on the gated sets; `KNOWN_REAL_MODEL_MISSES` empty (the two waitlist cases included). Phase cap $3.00. | Every gate met; the scorecard targets met |

### Phase 13 · Pilot readiness (S57–S60)
Goal: a real business can run its week on Pepper safely, and nothing breaks unseen. Exit: every category ≥ 8, except staff experience (7) and market competitiveness (6), which reach 8 in Phases 16 and 15.

| # | Target | Built | Done when |
|---|---|---|---|
| S57 | **Deploy** | A VPS with Docker Compose, a cheap neutral domain, TLS, Resend with SPF, DKIM and DMARC, secrets, and a deploy runbook. The user approves the production deploy. | Mail-tester score ≥ 9/10; the app reachable over HTTPS |
| S58 | **Operate** | Backups with a restore drill, Sentry and Grafana on (user creates the projects), alerts, Redis-backed rate limits, a load test against the SLOs, an uptime check. | Restore drill passes; SLOs met under load |
| S59 | **Support, legal and metrics** | "Tell us what went wrong" (reaches the user the same day), a help page, terms and privacy policy (AI and memory included), AI disclosure in emails, the pilot metrics page ([scorecard.md](scorecard.md) §3) from the activation events and the audit log. | Every metric has a number on a seeded business |
| S60 | **Security review + pilot gate** | Full security review; a real iPhone push test and the VoiceOver/NVDA check (user); OpenAI zero data retention confirmed (user); the scorecard. Pilot go/no-go. | Scorecard targets met; no open high finding |

**🚦 Private pilot:** 3–5 owners from the target segment, email only, free for 60 days, a 15-minute setup call and a weekly check-in. The pilot measures §6.

### Phase 14 · SMS (S61–S64)
Goal: reminders and confirmations by text, and the owner can approve by text. Exit: market competitiveness 7.

| # | Target | Built | Done when |
|---|---|---|---|
| S61 | **SMS channel** | A provider adapter (Twilio-class; ADR), consent capture on the booking page (TCPA wording), STOP/HELP, quiet hours, SMS as an outbox channel, sandbox mode. | Contract tests against the provider's sandbox; STOP honoured in < 1 minute |
| S62 | **SMS reminders + confirm by text** | 24 h and same-day reminders (bookings made under 24 h ahead get one too), "C" to confirm, a reschedule link, owner settings. | Reminder timing and idempotency tests (as AC-W6-1 and AC-W4-2) |
| S63 | **Approve by text** | Pepper texts the owner a card summary ("Tue 2pm opened. Offer to Audy, Marco, Sam? Reply Y"); single-use signed codes, an expiry, sender verification, no personal data beyond first names. | A reply only approves the exact card shown; replay and spoof tests |
| S64 | **SMS live + gate** | Live once 10DLC registration is approved (needs the LLC); `send_client_message` over SMS. Phase gate. If 10DLC isn't approved yet, everything stays in sandbox and this session is the gate only. | Scorecard target met |

### Phase 15 · Deposits (S65–S68)
Goal: no-shows cost the owner nothing, and money never moves without the owner's OK. Exit: market competitiveness 8.

| # | Target | Built | Done when |
|---|---|---|---|
| S65 | **Stripe Connect Express** | Owner onboarding to Stripe, account status in Pepper, idempotent webhooks (ADR). | Webhook replay and signature tests |
| S66 | **Deposits and card on file** | A deposit rule per service, Stripe-hosted payment fields on the booking page (no card data touches Pepper), card on file, refunds on cancel per policy. | Test-mode journeys for pay, cancel and refund |
| S67 | **Smart deposits + policy builder** | Deposits only for new clients and clients with a no-show history; regulars exempt; a cancellation-policy builder whose text appears on the booking page and in emails. | The rule's fixture tests; the policy shown in every channel |
| S68 | **No-show fee by approval + gate** | Charge or waive on a card, never automatic; receipts that hold up in a dispute. Phase gate. | No charge without an approved card, proven by tests |

### Phase 16 · Calendar + staff (S69–S72)
Goal: staff plan their week in Pepper and their personal calendar blocks bookings. Exit: staff experience 8.

| # | Target | Built | Done when |
|---|---|---|---|
| S69 | **Week view + drag to move** | Week view per staff member; drag to move asks whether to tell the client. | Playwright drag journeys; no move without the double-booking check |
| S70 | **Google Calendar in** | OAuth, busy blocks from staff calendars into availability (the old Phase 10). The user starts Google's OAuth verification in Phase 10. | Contract tests; token-expiry scenario |
| S71 | **Google Calendar out** | Bookings as events, incremental sync, reconciliation. | Conflict and duplicate scenarios |
| S72 | **Recurring appointments + staff week** | "Every Tue 7 am for 8 weeks", with each date checked; staff's "My week". Phase gate. | Recurrence property tests |

### Phase 17 · Launch gate (S73–S76)
Goal: Pepper can charge owners and be found. Exit: every category ≥ 9; public-launch readiness 9.

| # | Target | Built | Done when |
|---|---|---|---|
| S73 | **Reports** | Five numbers: booked revenue, no-show rate, rebook rate, top services, dollars Pepper filled. | Numbers equal the fixture sums |
| S74 | **Pepper billing** | Stripe Billing subscriptions, a 30-day trial, plans priced from the pilot (hypothesis: solo $29–49, shop $79–99, SMS included, no per-seat pricing), dunning, self-serve cancel. | Test-mode journeys for trial, pay, fail and cancel |
| S75 | **Landing page** | Positioning, the trust line, pricing, a pilot case study, signup. | Lighthouse ≥ 95 on mobile |
| S76 | **Final gate** | Full re-record for model drift (Rec, $1.50 cap), security review, launch checklist, final scorecard. Paid-launch go/no-go. | Every category ≥ 9; the go/no-go recorded |

## 6. What the pilot must prove (the hypotheses)

| Hypothesis (from the simulated interviews) | Measured as | Kept if |
|---|---|---|
| Owners prefer tapping cards to chatting | Card actions ÷ (card actions + chat turns) | ≥ 70% |
| Auto-fill is used, not just wanted | Fill offers approved ÷ shown | ≥ 60% |
| Owners come back daily | Active on ≥ 4 days a week | ≥ 60% of pilot owners |
| Migration fear is removed by import | Imports completed ÷ started; support asks about import | ≥ 90%; ≤ 1 per owner |
| Solo price $29–49 with SMS is right | Pilot exit: "would you pay $X?" | ≥ 1 owner yes at the plan price |

A hypothesis that fails goes to a decision round (grilling) before the next phase.

## 7. Not in V1 (on purpose)

- **POS / payments at checkout:** owners keep their card reader; Stripe Terminal after V1.
- **Reserve with Google:** apply early, build after V1.
- **V1.1:** booking-page layouts, goals, two-way chat by text.
- **After PMF:** mini-website on the owner's domain, booth-rental shops, clinical studios, voice, multi-location, classes and memberships, gift cards, packages, product sales, inventory, payroll, mass marketing, a marketplace.
- **Direct database connections** to an owner's own app (P1-13): after V1, as a "we move you" migration service.
- **Website / Google profile / photo extraction** (the old Phase 9, AC-W1-1/2): after V1.

## 8. Budget

| Phase | Real-model sessions | Cap |
|---|---|---|
| 9–11, 13–16 | none | $0 |
| 12 | S56b | $3.00 |
| 17 | S76 | $1.50 |
| Reserve | a fix round in a "b" half | $5.50 |
| **V1 total** | | **$10.00** on top of the $3.80 spent |

Development evals run on the `pepper-dev-evals` OpenAI project with data sharing on (free daily tokens first, money only past them). The ledger stays the record ([ai-budget.md](ai-budget.md)).
