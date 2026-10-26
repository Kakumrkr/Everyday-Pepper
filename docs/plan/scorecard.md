# Product Scorecard

The fifteen categories Pepper is judged by, from the launch-readiness review of 2026-10-25, with what each score looks like and the target at every gate. Planning session P1 (2026-10-26) adopted it ([PCR-007](changes/PCR-007.md), [V1 playbook](v1-playbook.md)).

**How it is used:**
- Every phase's last session scores each category with evidence (a test, a screenshot, a metric or a file) and updates the "Now" column.
- A phase is not done below its target. A category that misses goes into the next phase's first brief.
- Scale: 0–2 concept · 3–4 early prototype · 5–6 usable but incomplete · 7–8 credible pilot · 9 strong commercial · 10 market leader.

## 1. Categories

| # | Category | Review (10-25) | Now | Pilot gate (S60) | Launch gate (S76) | What 10 looks like |
|---|---|---|---|---|---|---|
| C1 | Core usefulness | 5 | 5 | 8 | 9 | An owner runs the whole week in Pepper (book, remind, deposit, fill, report) and never opens another tool |
| C2 | Realism and completeness | 4 | 4 | 8 | 9 | A new business looks fully real in 10 minutes: menu, prices, hours, photos, contact, policy |
| C3 | Friendly UX | 6 | 6 | 9 | 9 | No dead ends, no jargon; every screen has one clear next step; owners describe it as "easy" without prompting |
| C4 | Mobile usability | 6 | 6 | 9 | 9 | Every flow done one-thumbed at 375 px in under 90 seconds; screenshot tests at 3 widths × 2 themes |
| C5 | Owner experience | 5 | 5 | 8 | 9 | The day's work is a card board of one-tap decisions ranked by dollars; the trust controls are easy to find |
| C6 | Staff experience | 4 | 4 | 7 | 9 | Staff see their day and week, add walk-ins, and their personal calendar blocks bookings |
| C7 | Customer booking | 5 | 5 | 8 | 9 | Booking in < 60 s on a phone; contact details, policy and the business's brand on the page; drop-off ≤ 15% at any step |
| C8 | AI trust and safety | 8 | 8 | 9 | 10 | 100% pass^3 on the safety sets; every action explained and undoable; the owner can see exactly what Pepper said to whom |
| C9 | Reliability | 6 | 6 | 8 | 9 | Deployed, monitored, backed up with a passed restore drill, SLOs met under load, 30 days with no unseen error |
| C10 | Accessibility | 6 | 6 | 8 | 9 | WCAG 2.2 AA on every screen, axe clean, the manual screen-reader check passed, reduced motion honoured |
| C11 | Security and privacy | 6 | 6 | 9 | 9 | Recovery, verification, MFA, export, deletion, terms and privacy policy; no open high finding; zero data retention on the production AI project |
| C12 | Market competitiveness | 3 | 3 | 6 | 9 | Everything owners rely on daily (SMS, deposits, week view, sync, reports) plus the Pepper-only features |
| C13 | Switching value | 2 | 2 | 8 | 9 | "We move you": an import from any of the five tools with history, in minutes, undoable |
| C14 | Pilot readiness | 3 | 3 | 9 | — | Deployed, a sending domain, support the same day, metrics from day one |
| C15 | Public-launch readiness | 1 | 1 | — | 9 | Billing, a landing page, legal pages, pricing, support, a case study |

The pilot gate accepts C6 at 7 and C12 at 6. They reach 8 in Phases 16 and 15, while the pilot runs on email.

## 2. Targets by phase exit

| Phase exit | Categories that must reach the number |
|---|---|
| 9 · New look (S43) | C3 8 · C4 8 · C10 8 |
| 10 · First 10 minutes (S47) | C1 6 · C2 6 · C5 7 · C7 7 |
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
