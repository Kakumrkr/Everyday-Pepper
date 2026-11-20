# Product Scorecard

The fifteen categories Pepper is judged by, from the launch-readiness review of 2026-10-25, with what each score looks like and the target at every gate. Planning session P1 (2026-10-26) adopted it ([PCR-007](changes/PCR-007.md), [V1 playbook](v1-playbook.md)).

**How it is used:**
- Every phase's last session scores each category with evidence (a test, a screenshot, a metric or a file) and updates the "Now" column.
- A phase is not done below its target. A category that misses goes into the next phase's first brief.
- Scale: 0–2 concept · 3–4 early prototype · 5–6 usable but incomplete · 7–8 credible pilot · 9 strong commercial · 10 market leader.

## 1. Categories

| # | Category | Review (10-25) | Now | Pilot gate (S60) | Launch gate (S76) | What 10 looks like |
|---|---|---|---|---|---|---|
| C1 | Core usefulness | 5 | 8 | 8 | 9 | An owner runs the whole week in Pepper (book, remind, deposit, fill, report) and never opens another tool |
| C2 | Realism and completeness | 4 | 7 | 8 | 9 | A new business looks fully real in 10 minutes: menu, prices, hours, photos, contact, policy |
| C3 | Friendly UX | 6 | 8 | 9 | 9 | No dead ends, no jargon; every screen has one clear next step; owners describe it as "easy" without prompting |
| C4 | Mobile usability | 6 | 8 | 9 | 9 | Every flow done one-thumbed at 375 px in under 90 seconds; screenshot tests at 3 widths × 2 themes |
| C5 | Owner experience | 5 | 8 | 8 | 9 | The day's work is a card board of one-tap decisions ranked by dollars; the trust controls are easy to find |
| C6 | Staff experience | 4 | 4 | 7 | 9 | Staff see their day and week, add walk-ins, and their personal calendar blocks bookings |
| C7 | Customer booking | 5 | 7 | 8 | 9 | Booking in < 60 s on a phone; contact details, policy and the business's brand on the page; drop-off ≤ 15% at any step |
| C8 | AI trust and safety | 8 | 9 | 9 | 10 | 100% pass^3 on the safety sets; every action explained and undoable; the owner can see exactly what Pepper said to whom |
| C9 | Reliability | 6 | 6 | 8 | 9 | Deployed, monitored, backed up with a passed restore drill, SLOs met under load, 30 days with no unseen error |
| C10 | Accessibility | 6 | 8 | 8 | 9 | WCAG 2.2 AA on every screen, axe clean, the manual screen-reader check passed, reduced motion honoured |
| C11 | Security and privacy | 6 | 8 | 9 | 9 | Recovery, verification, MFA, export, deletion, terms and privacy policy; no open high finding; zero data retention on the production AI project |
| C12 | Market competitiveness | 3 | 7 | 6 | 9 | Everything owners rely on daily (SMS, deposits, week view, sync, reports) plus the Pepper-only features |
| C13 | Switching value | 2 | 8 | 8 | 9 | "We move you": an import from any of the five tools with history, in minutes, undoable |
| C14 | Pilot readiness | 3 | 3 | 9 | — | Deployed, a sending domain, support the same day, metrics from day one |
| C15 | Public-launch readiness | 1 | 1 | — | 9 | Billing, a landing page, legal pages, pricing, support, a case study |

The pilot gate accepts C6 at 7 and C12 at 6. They reach 8 in Phases 16 and 15, while the pilot runs on email.

## 2. Targets by phase exit

| Phase exit | Categories that must reach the number |
|---|---|
| 9 · New look (S43.2) | C3 8 · C4 8 · C10 8 (met, S43.2: §5) |
| 10 · First 10 minutes (S47.3) | C1 6 · C2 6 · C5 7 · C7 7 (met, S47.3: §6) |
| 11 · Switching + privacy (S51.2) | C13 8 · C11 8 (met, S51.2: §7) |
| 12 · The employee (S56b) | C1 8 · C5 8 · C8 9 (met, S56b: §8) |
| 13 · Pilot readiness (S60) | the "Pilot gate" column |
| 14 · SMS (S64) | C12 7 (met in sandbox, S64: §9) |
| 15 · Deposits (S68) | C12 8 |
| 16 · Calendar + staff (S72) | C6 8 |
| 17 · Launch gate (S76) | the "Launch gate" column |

## 3. Pilot metrics (instrumented from Phase 10, on a page from S59)

| Metric | Definition | Pilot target |
|---|---|---|
| Onboarding completion | Signups reaching bookable (a service, staff, hours) | ≥ 80% |
| Time to bookable | Signup → bookable | Median ≤ 10 min |
| Time to first booking | Signup → first confirmed booking | Median ≤ 15 min |
| Weekly active owners | Active on ≥ 4 days a week | ≥ 60% |
| Cards vs chat | Card actions ÷ (card actions + chat turns) | ≥ 70% |
| AI approval rate | Proposals approved ÷ shown | 70–90% |
| AI correction rate | Edited, or followed by "no, I meant…" | ≤ 10% |
| Undo rate | AI actions undone as wrong ÷ executed | < 1% |
| Fill rate | Cancelled slots refilled ÷ cancelled | Tracked; target set after week 2 |
| Booking completion | Public flow starts → confirmed | ≥ 60% |
| Code-step drop-off | Leave at the email code ÷ reach it | ≤ 15% |
| No-show rate | `no_show` ÷ past bookings | Below the owner's baseline; −30% with SMS |
| Rebook rate | Clients rebooked within their interval | +10 points vs baseline |
| Waitlist conversion | Offers claimed ÷ sent | ≥ 30% |
| Support requests | Per active business per week | ≤ 1 after week 2 |
| First-reply time | A business request's first message → the team's first reply (S59.4) | Median ≤ 4 h; every request the same day |
| AI cost per business | OpenAI spend per active business per month | ≤ $3 |

## 4. Score history

| Date | Session | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 | C13 | C14 | C15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-25 | Review (S38b) | 5 | 4 | 6 | 6 | 5 | 4 | 5 | 8 | 6 | 6 | 6 | 3 | 2 | 3 | 1 |
| 2026-10-28 | Phase 9 gate (S43.2) | 5 | 4 | 8 | 8 | 5 | 4 | 5 | 8 | 6 | 8 | 6 | 3 | 2 | 3 | 1 |
| 2026-11-03 | Phase 10 gate (S47.3) | 6 | 7 | 8 | 8 | 7 | 4 | 7 | 8 | 6 | 8 | 6 | 3 | 2 | 3 | 1 |
| 2026-11-04 | Phase 11 gate (S51.2) | 6 | 7 | 8 | 8 | 7 | 4 | 7 | 8 | 6 | 8 | 8 | 3 | 8 | 3 | 1 |
| 2026-11-06 | Phase 12 gate (S56b) | 8 | 7 | 8 | 8 | 8 | 4 | 7 | 9 | 6 | 8 | 8 | 3 | 8 | 3 | 1 |
| 2026-11-20 | Phase 14 gate (S64) | 8 | 7 | 8 | 8 | 8 | 4 | 7 | 9 | 6 | 8 | 8 | 7 | 8 | 3 | 1 |

## 5. Phase 9 gate (S43.2, 2026-10-28): the evidence

Scored by Claude in S43.2 from the tests and baselines below; only C3, C4 and C10 were scored, the rest carry over.

- **C3 Friendly UX 6 → 8.** Every screen is on the kit (ADR-0044: shell, Home, Chat, cards S41; Calendar, Clients S42; sheets, Services, Team S42.2; Autonomy, What I know, Waitlist S42.3; public pages S43; account screens S43.2), so no screen uses the stylesheet from before it (AC-X-12). Every empty screen offers its next step (AC-X-8–10), a cancelled booking offers "Book again" (S43), and errors say what to do (copy pass, `apps/web/lib/client-api.ts`). Not yet 9: Team and Services empty show two primary buttons and a staff page has two (S42.2 gaps); the staff page named the zone id (plain names since S46); no owner has used it yet (the pilot).
- **C4 Mobile usability 6 → 8.** Screenshot baselines at 375 / 412 / 1280 px × light / dark for every screen (`e2e/tests/screens.spec.ts`, `gallery.spec.ts`); tap targets ≥ 44 px on every screen at 375 px (`tap-targets.ts`); the main action at the bottom of the phone on every sheet, the booking page and the account screens (`expectStickyAtTheBottom`); no sideways scroll checks. Not yet 9: no timed one-thumb run of every flow, no real-phone check (before the pilot).
- **C10 Accessibility 6 → 8.** axe (WCAG 2.2 A/AA) finds nothing serious on every signed-in, public and account screen, light and dark, phone and desktop (`e2e/tests/accessibility.spec.ts`); contrast pairs and reduced-motion tokens tested (`packages/ui/src/theme.test.ts`); visible labels with hints and errors tied to the field (kit `Input`); keyboard journeys in the specs. Not yet 9: the manual VoiceOver/NVDA check (STATUS "Waiting on the user" 4, before S60).

## 6. Phase 10 gate (S47.3, 2026-11-03): the evidence

Scored by Claude in S47.3 from the tests below; only C1, C2, C5 and C7 were scored, the rest carry over. The times are the owner time model's (`packages/testing/src/owner-time.ts`: keystroke-level costs slowed for one thumb on a phone, fixed costs for the mail app, an email's wait, the camera roll and an authenticator), charged action by action in `e2e/tests/new-owner-journey.spec.ts` at 375 px; the wall clock there measures the machine.

- **C1 Core usefulness 5 → 6.** A new barber signs up, confirms the email, picks the type, turns on two-step verification, checks the setup, adds a cover and a logo, the contact details and a policy, and copies the link in **7:06** (AC-W1-15; time to bookable's pilot target is a median ≤ 10 min); a client then books. Recovery, verification and change of email (S44) close the account dead ends. Not yet 8: reminders by text, deposits and filling cancellations come in Phases 12–15.
- **C2 Realism and completeness 4 → 7.** Everything on "what 10 looks like" is there in that run: the type fills the menu, prices, durations and hours (AC-W1-7); photos (logo, cover, a gallery of 12, ADR-0048, AC-W8-10…12); phone, public address and cancellation policy (AC-W8-7); the brand color with its contrast guard. Not yet 8: only four featured types are tuned, no service descriptions or per-service photos, and no real owner has built a page yet (the pilot).
- **C5 Owner experience 5 → 7.** Home leads a new owner one step at a time with no dead end: an empty menu says where to start; a seeded one asks to check it (AC-W1-11); what stops a booking is named with its fix (AC-W1-12); a page without a cover gets a Tip to add photos (AC-W1-16); then the link with Copy and the week in one line (AC-W1-13/14); the feed, undo and autonomy controls from Phases 5–8 on the kit (Phase 9). Not yet 8: the card board ranked by dollars and the activity log (Phase 12); two-step setup is 2:14 of the 7:06.
- **C7 Customer booking 5 → 7.** Contact, policy, brand and photos on the page (AC-W8-7, AC-W8-12); only bookable people offered, the first free day opened, a failed day retried in place (AC-W8-3…5); a remembered phone skips the code (AC-W8-8); drop-off per step counted with nothing personal (AC-W8-9). A new client books in **1:35** by the model (50 s of it the code email) and again from the same phone in **0:34** (AC-W8-13). Not yet 8: the first booking is over a minute; the staff step shows even when one person offers the service (for later); drop-off has no real traffic yet (S59 reads it).
- **Phase-exit security review** (`/security-review`, S47.3): S47.3's diff and a cross-session pass over S46–S47.2 (S44/S45's auth configuration and migrations 0051–0052 read in the current tree): no high or medium finding. The remembered-device token is bound to the business and the email, stored as a hash, the cookie path per business; public photos and funnel writes are scoped by the page's slug; uploads are typed by content with the pixel limit before decoding and server-made object keys; every new table has forced RLS and is in the isolation suite. Logged as low:
  - **L15** A finished email change does not end the account's other sessions (both addresses must confirm first). Phase 11, with account deletion. **Closed in S51.2** (AC-W1-43).
  - **L16** With email down, a request carrying an unknown device cookie stores the booking request before answering 503 (the mailer check used to come first). Ordering only; fix when the booking flow is next touched.
  - **L17** Funnel counts can be inflated with random visit ids within the per-address rate limit. Accepted as analytics noise; S59 reads the funnel with an inflation guard.



## 7. Phase 11 gate (S51.2, 2026-11-04): the evidence

Scored by Claude in S51.2 from the tests below; only C11 and C13 were scored, the rest carry over (C6's walk-ins, S50.2, are scored at Phase 16's gate).

- **C13 Switching value 2 → 8.** Clients from any of the five tools' exports or any CSV/JSON/JSONL, mapped by preset or by header and value patterns, previewed with reasons per row, matched (id → email → phone → name) and merged, undoable for 7 days (ADR-0049, AC-W1-3, AC-W1-17…21); past visits and upcoming appointments with conflicts listed and no email sent, 1,000 clients and 5,000 visits in under 2 minutes (ADR-0050, AC-W1-22…29); merge and delete (ADR-0051); the export imports back with nothing mapped and no duplicates (ADR-0053, AC-W1-37…38, `apps/api/src/export.int.test.ts`). Not yet 9: no owner has moved in yet (the pilot), and the mapping of an unknown file is by rules (AI suggestions in S56a).
- **C11 Security and privacy 6 → 8.** On top of recovery, email verification and change, and MFA for owners and managers (S44, ADR-0045): the owner-only export (ADR-0053); **deletion** of a business and of an account with 30 days to change one's mind, the business's rows proved gone from every `tenant_id` table, an early delete refused by the database itself, the account's sign-in and sessions gone and business records naming nobody (ADR-0054, AC-W1-40…42, `packages/db/src/deletion.int.test.ts`, `apps/api/src/deletion.int.test.ts`, `apps/worker/src/jobs.int.test.ts`); **L15 closed** (AC-W1-43, `apps/api/src/auth.int.test.ts`); terms and privacy drafts (`docs/legal/`, S51); the isolation suite at 100%. `/code-review` and a security pass on S51.2: no high or medium finding (the 4 fixed review findings in session-log). Not yet 9: zero data retention on the production AI project and backup retention (STATUS "Waiting on the user" 4, S58), the terms reviewed (S59), the pre-pilot security review (S60).

## 8. Phase 12 gate (S56b, 2026-11-06): the evidence

Scored by Claude in S56b from the tests and the recording below; only C1, C5 and C8 were scored, the rest carry over. The recording is on `gpt-6-luna` / `gpt-6.1-sol` (low), $0.80 of the phase's $3.00 ([ai-budget.md](ai-budget.md)).

- **C1 Core usefulness 6 → 8.** Pepper now does the week's follow-through by itself or from one card: it books, moves and cancels from chat with the owner's OK, sends a client a reminder or a "running late" note about a booked visit and marks a no-show with a day's Undo (ADR-0060, AC-W2-5…8); it fills freed times from the waitlist and then from regulars (ADR-0056), drafts win-back emails for clients who drifted away (ADR-0057), asks happy clients for a review (ADR-0059) and says each week what it did and the minutes saved (ADR-0058); an owner moving in from another tool gets the columns the rules couldn't place suggested (ADR-0061, AC-W1-46…48). Every one of those tools passes on the real model (the table in ADR-0060). Not yet 9: reminders by text and deposits (Phases 14–15), a week view and calendar sync (Phase 16), the five-number report (Phase 17); no owner has run a week in it yet (the pilot).
- **C5 Owner experience 7 → 8.** Home's cards are ranked by the dollars at stake, from the business's own prices, with "Dismiss all" (S52, AC-W4-4); Activity lists everything Pepper did with its Undo (S52, AC-W7-4); the Autonomy page in More offers three presets with every action's own setting read back as standing rules (ADR-0055, AC-W7-5); the import preview speaks in one plain sentence (AC-W1-21, zeros left out in S56b) and says what is left out and why (AC-W1-48). Not yet 9: no timed owner run of a day's cards; approval by text comes in S63.
- **C8 AI trust and safety 8 → 9.** **100% pass^3** on every safety and trust set: safety 21/21, permissions 9/9, autonomy 13/13, memory_delete 12/12, memory_safety 14/14, feed_safety 11/11, and scheduling, memory_recall, episodic and drafts at 100% too, import_mapping 7/8 over its 0.8 gate (186 cases × 3; one import trial left a column empty, the safe side); `KNOWN_REAL_MODEL_MISSES` empty for the first time since S37b (the two waitlist cases pass after the S44 domain check); the replay test (`packages/ai/src/evals/evals.int.test.ts`) holds it in CI. Honest refusals name no place that doesn't exist (prompt v9, checked by `cant-text-yet` and `cant-refund-yet`); the model sees an import's column names only as untrusted data and masked samples, and the domain checks every suggestion (ADR-0061); every action is explained, audited and undoable (Activity, S52) and the owner sees the words of every client message on its card (ADR-0060). Not yet 10: zero data retention on the production project (before the pilot), one memory_write miss at pass^1 (`mw-staff-fact`, safe), and no outside red-team.

## 9. Phase 14 gate (S64, 2026-11-20): the evidence

Scored by Claude in S64 from the tests below; only C12 was scored, the rest carry over. **SMS is built and proven in the sandbox, not live:** going live needs the LLC, a paid provider and 10DLC registration (S64.2, [PCR-012](changes/PCR-012.md)). The score credits what an owner gets the day the switch is on, as earlier gates credited features no owner had used yet; the gap is named below.

- **C12 Market competitiveness 3 → 7.** Texts, the feature owners in the segment rely on most after booking itself, are complete: Twilio behind a port with a sandbox that never leaves the machine (ADR-0065); consent with the words agreed to, STOP/START/HELP answered in the signed webhook's own request, quiet hours, delivery status and GSM-7 segments (AC-X-57…69: contracts `sms.test.ts`, runtime `sms.test.ts`, db and core `sms.int.test.ts`, api `sms.int.test.ts`, `sms-webhook.controller.test.ts`, `twilio-signature.test.ts`); the day-before and same-day reminders and "C" to confirm, with owner settings (AC-X-70…79: appointments `reminders.int.test.ts`, `reminder-texts.int.test.ts`; e2e `texts-settings.spec.ts`, `confirm-by-text.spec.ts`); the booking page's opt-in (e2e `public-booking.spec.ts`). On top, the Pepper-only part competitors don't have: **cards approved or skipped by text** ("Y"/"N" and a single-use code, sender-checked, the exact card shown; ADR-0066, AC-X-80…95: core `approval-texts.int.test.ts`, `member-texts.int.test.ts`, api `sms-approval.int.test.ts`, e2e `approve-by-text.spec.ts`). The client's last text and "Confirmed by text" are on the profile and the visit (AC-X-76…79, `screens.spec.ts`). Not yet 8: no deposits or card on file (Phase 15), no week view or calendar sync (Phase 16), no reports (Phase 17); not yet live (no real carrier has carried a text: 10DLC), and the AI's `send_client_message` doesn't text yet (S64.2).
