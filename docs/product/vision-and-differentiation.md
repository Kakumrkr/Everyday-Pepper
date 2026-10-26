# Vision & Differentiation

## Vision
An **AI Employee** for small service businesses: owners and staff run operations by approving what it prepares, with one tap, or by asking it in chat. It executes tasks, remembers how the business works, spots opportunities, and follows through. One app serves many business types through a layered design (see `../architecture/overview.md`).

**Positioning:** *You're hiring an employee, not buying software.* Since P1 (2026-10-26, [ADR-0043](../adr/0043-card-board-first-interaction.md)) the V1 line is: ***The front-desk employee that keeps your chair full. Approve with one tap, undo anything.*** The product is the outcome (chair full, no-shows down, proven weekly in dollars); the cards and the chat are only how owners get it.

## Problems we solve (V1, appointment-based businesses)
| # | Problem | Today | With us |
|---|---|---|---|
| P1 | Admin steals time from clients | Clicking through calendars and menus between appointments | One sentence: "Move Sarah to Thursday at 2" |
| P2 | Lost revenue nobody notices | Empty slots, lapsed regulars, no-shows sit in reports | The operator feed surfaces them with a ready-to-approve action |
| P3 | Business knowledge lives in the owner's head | Preferences, allergies, policies undocumented | Persistent, editable memory and enforced rules |
| P4 | Forgotten follow-ups | Reminders, rebooking nudges, to-dos slip | Scheduled tasks and reminders the AI owns |
| P5 | Setup & switching pain | Hours of configuration; data trapped in old tool | Setup in about 10 minutes from existing sources; CSV import |
| P6 | Distrust of automation | All-or-nothing AI | Autonomy dial, explanations, undo |

## Differentiation pillars
1. **Tap instead of type.** A daily card board of one-tap decisions ranked by dollars ([ADR-0043](../adr/0043-card-board-first-interaction.md)); standing rules make most cards unnecessary; chat for anything else, replying with the same cards. Classic views remain.
2. **Operator feed.** Home = Done / Needs your OK / Suggestions. Smart waitlist fills cancellations.
3. **Trust layer.** Autonomy dial per action type, "Why did you do that?", undo everything, "What I know about your business".
4. **Zero-setup onboarding.** From website, Google Business profile, or a price-list photo; competitor CSV import.

**Identity commitments:** branded booking page with no competitor listings · no commission on the business's own clients · transparent pricing · free full data export · month-to-month.

Evidence for these gaps: `../research/competitor-audit.md`.

## Baseline plus "only in Pepper" (P1, 2026-10-26)
Owners switch when what they rely on every day is there and something earns them money that their tool doesn't. V1 matches the baseline (booking page, SMS, deposits, import, week view, Google sync, recurring, reports, review requests) and adds what no competitor does on the owner's side:

| Pepper-only | What it does |
|---|---|
| Cancellation → filled, with a receipt | Fills the gap from the waitlist and overdue regulars, then says "+$60" |
| Win-back in the owner's voice | Drafts the "haven't seen you" message from what Pepper remembers, sends on one tap |
| "Pepper earned you $X" weekly | Proves its value in dollars and minutes |
| Trust layer | Approval, Why?, undo, activity log, autonomy that earns trust from evidence |
| Memory | "Audy prefers Randy, mornings" applied when booking |
| Standing rules in plain words | "Never put a full set in a gap under 2 hours" |
| Morning briefing and evening wrap | The day in ten seconds, tomorrow's risks the night before |
| Smart deposits | Deposits only from new and at-risk clients; regulars never asked |
| Approve by text | The card arrives as a text; reply Y |
| "We move you" | Import with history, free export, no commission, month to month |

## Success metrics (pilot)
- ≥ 70% of scheduling actions performed through the AI (cards or chat); full list in [scorecard.md](../plan/scorecard.md) §3
- Onboarding to first booking ≤ 15 minutes (median)
- 0 double bookings · 0 cross-tenant data incidents
- < 1% of AI actions undone as wrong
- ≥ 60% weekly active owners; ≥ 50% of feed suggestions acted on
- AI cost per tenant within budget (see `../engineering/deployment-and-costs.md`)
