# Product Scorecard

The fifteen categories Pepper is judged by, from the launch-readiness review of 2026-10-25, with what each score looks like and the target at every gate. Planning session P1 (2026-10-26) adopted it ([PCR-007](changes/PCR-007.md), [V1 playbook](v1-playbook.md)).

**How it is used:**
- Every phase's last session scores each category with evidence (a test, a screenshot, a metric or a file) and updates the "Now" column.
- A phase is not done below its target. A category that misses goes into the next phase's first brief.
- Scale: 0–2 concept · 3–4 early prototype · 5–6 usable but incomplete · 7–8 credible pilot · 9 strong commercial · 10 market leader.

## 1. Categories

| # | Category | Review (10-25) | Now | Pilot gate (S60) | Launch gate (S76) | What 10 looks like |
|---|---|---|---|---|---|---|
| C1 | Core usefulness | 5 | 6 | 8 | 9 | An owner runs the whole week in Pepper (book, remind, deposit, fill, report) and never opens another tool |
| C2 | Realism and completeness | 4 | 7 | 8 | 9 | A new business looks fully real in 10 minutes: menu, prices, hours, photos, contact, policy |
| C3 | Friendly UX | 6 | 8 | 9 | 9 | No dead ends, no jargon; every screen has one clear next step; owners describe it as "easy" without prompting |
| C4 | Mobile usability | 6 | 8 | 9 | 9 | Every flow done one-thumbed at 375 px in under 90 seconds; screenshot tests at 3 widths × 2 themes |
| C5 | Owner experience | 5 | 7 | 8 | 9 | The day's work is a card board of one-tap decisions ranked by dollars; the trust controls are easy to find |
| C6 | Staff experience | 4 | 4 | 7 | 9 | Staff see their day and week, add walk-ins, and their personal calendar blocks bookings |
| C7 | Customer booking | 5 | 7 | 8 | 9 | Booking in < 60 s on a phone; contact details, policy and the business's brand on the page; drop-off ≤ 15% at any step |
| C8 | AI trust and safety | 8 | 8 | 9 | 10 | 100% pass^3 on the safety sets; every action explained and undoable; the owner can see exactly what Pepper said to whom |
| C9 | Reliability | 6 | 6 | 8 | 9 | Deployed, monitored, backed up with a passed restore drill, SLOs met under load, 30 days with no unseen error |
| C10 | Accessibility | 6 | 8 | 8 | 9 | WCAG 2.2 AA on every screen, axe clean, the manual screen-reader check passed, reduced motion honoured |
| C11 | Security and privacy | 6 | 6 | 9 | 9 | Recovery, verification, MFA, export, deletion, terms and privacy policy; no open high finding; zero data retention on the production AI project |
| C12 | Market competitiveness | 3 | 3 | 6 | 9 | Everything owners rely on daily (SMS, deposits, week view, sync, reports) plus the Pepper-only features |
| C13 | Switching value | 2 | 2 | 8 | 9 | "We move you": an import from any of the five tools with history, in minutes, undoable |
| C14 | Pilot readiness | 3 | 3 | 9 | — | Deployed, a sending domain, support the same day, metrics from day one |
| C15 | Public-launch readiness | 1 | 1 | — | 9 | Billing, a landing page, legal pages, pricing, support, a case study |

The pilot gate accepts C6 at 7 and C12 at 6. They reach 8 in Phases 16 and 15, while the pilot runs on email.

## 2. Targets by phase exit

| Phase exit | Categories that must reach the number |
|---|---|
| 9 · New look (S43.2) | C3 8 · C4 8 · C10 8 (met, S43.2: §5) |
| 10 · First 10 minutes (S47.3) | C1 6 · C2 6 · C5 7 · C7 7 (met, S47.3: §6) |
| 11 · Switching + privacy (S51) | C13 8 · C11 8 |
| 12 · The employee (S56b) | C1 8 · C5 8 · C8 9 |
| 13 · Pilot readiness (S60) | the "Pilot gate" column |
| 14 · SMS (S64) | C12 7 |
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
| AI cost per business | OpenAI spend per active business per month | ≤ $3 |

## 4. Score history

| Date | Session | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 | C13 | C14 | C15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-25 | Review (S38b) | 5 | 4 | 6 | 6 | 5 | 4 | 5 | 8 | 6 | 6 | 6 | 3 | 2 | 3 | 1 |
| 2026-10-28 | Phase 9 gate (S43.2) | 5 | 4 | 8 | 8 | 5 | 4 | 5 | 8 | 6 | 8 | 6 | 3 | 2 | 3 | 1 |
| 2026-11-03 | Phase 10 gate (S47.3) | 6 | 7 | 8 | 8 | 7 | 4 | 7 | 8 | 6 | 8 | 6 | 3 | 2 | 3 | 1 |

## 5. Phase 9 gate (S43.2, 2026-10-28): the evidence

Scored by Claude in S43.2 from the tests and baselines below; only C3, C4 and C10 were scored, the rest carry over.

- **C3 Friendly UX 6 → 8.** Every screen is on the kit (ADR-0044: shell, Home, Chat, cards S41; Calendar, Clients S42; sheets, Services, Team S42.2; Autonomy, What I know, Waitlist S42.3; public pages S43; account screens S43.2), so no screen uses the stylesheet from before it (AC-X-12). Every empty screen offers its next step (AC-X-8–10), a cancelled booking offers "Book again" (S43), and errors say what to do (copy pass, `apps/web/lib/client-api.ts`). Not yet 9: Team and Services empty show two primary buttons and a staff page has two (S42.2 gaps); the staff page named the zone id (plain names since S46); no owner has used it yet (the pilot).
- **C4 Mobile usability 6 → 8.** Screenshot baselines at 375 / 412 / 1280 px × light / dark for every screen (`e2e/tests/screens.spec.ts`, `gallery.spec.ts`); tap targets ≥ 44 px on every screen at 375 px (`tap-targets.ts`); the main action at the bottom of the phone on every sheet, the booking page and the account screens (`expectStickyAtTheBottom`); no sideways scroll checks. Not yet 9: no timed one-thumb run of every flow, no real-phone check (before the pilot).
- **C10 Accessibility 6 → 8.** axe (WCAG 2.2 A/AA) finds nothing serious on every signed-in, public and account screen, light and dark, phone and desktop (`e2e/tests/accessibility.spec.ts`); contrast pairs and reduced-motion tokens tested (`packages/ui/src/theme.test.ts`); visible labels with hints and errors tied to the field (kit `Input`); keyboard journeys in the specs. Not yet 9: the manual VoiceOver/NVDA check (STATUS "Waiting on the user" 4, before S60).

## 6. Phase 10 gate (S47.3, 2026-11-03): the evidence

Scored by Claude in S47.3 from the tests below; only C1, C2, C5 and C7 were scored, the rest carry over. The times are the owner time model's (`packages/testing/src/owner-time.ts`: keystroke-level costs slowed for one thumb on a phone, fixed costs for the mail app, an email's wait, the camera roll and an authenticator), charged action by action in `e2e/tests/new-owner-journey.spec.ts` at 375 px; the wall clock there measures the machine.

- **C1 Core usefulness 5 → 6.** A new barber signs up, confirms the email, picks the type, turns on two-step verification, checks the setup, adds a cover and a logo, the contact details and a policy, and copies the link in **7:04** (AC-W1-15; time to bookable's pilot target is a median ≤ 10 min); a client then books. Recovery, verification and change of email (S44) close the account dead ends. Not yet 8: reminders by text, deposits and filling cancellations come in Phases 12–15.
- **C2 Realism and completeness 4 → 7.** Everything on "what 10 looks like" is there in that run: the type fills the menu, prices, durations and hours (AC-W1-7); photos (logo, cover, a gallery of 12, ADR-0048, AC-W8-10…12); phone, public address and cancellation policy (AC-W8-7); the brand color with its contrast guard. Not yet 8: only four featured types are tuned, no service descriptions or per-service photos, and no real owner has built a page yet (the pilot).
- **C5 Owner experience 5 → 7.** Home leads a new owner one step at a time with no dead end: an empty menu says where to start; a seeded one asks to check it (AC-W1-11); what stops a booking is named with its fix (AC-W1-12); a page without a cover gets a Tip to add photos (AC-W1-16); then the link with Copy and the week in one line (AC-W1-13/14); the feed, undo and autonomy controls from Phases 5–8 on the kit (Phase 9). Not yet 8: the card board ranked by dollars and the activity log (Phase 12); two-step setup is 2:14 of the 7:04.
- **C7 Customer booking 5 → 7.** Contact, policy, brand and photos on the page (AC-W8-7, AC-W8-12); only bookable people offered, the first free day opened, a failed day retried in place (AC-W8-3…5); a remembered phone skips the code (AC-W8-8); drop-off per step counted with nothing personal (AC-W8-9). A new client books in **1:35** by the model (50 s of it the code email) and again from the same phone in **0:34** (AC-W8-13). Not yet 8: the first booking is over a minute; the staff step shows even when one person offers the service (for later); drop-off has no real traffic yet (S59 reads it).
- **Phase-exit security review** (`/security-review`, S47.3): S47.3's diff and a cross-session pass over S46–S47.2 (S44/S45's auth configuration and migrations 0051–0052 read in the current tree): no high or medium finding. The remembered-device token is bound to the business and the email, stored as a hash, the cookie path per business; public photos and funnel writes are scoped by the page's slug; uploads are typed by content with the pixel limit before decoding and server-made object keys; every new table has forced RLS and is in the isolation suite. Logged as low:
  - **L15** A finished email change does not end the account's other sessions (both addresses must confirm first). Phase 11, with account deletion.
  - **L16** With email down, a request carrying an unknown device cookie stores the booking request before answering 503 (the mailer check used to come first). Ordering only; fix when the booking flow is next touched.
  - **L17** Funnel counts can be inflated with random visit ids within the per-address rate limit. Accepted as analytics noise; S59 reads the funnel with an inflation guard.

