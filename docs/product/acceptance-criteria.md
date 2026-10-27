# Acceptance Criteria (V1)

Format: Given / When / Then. IDs (`AC-W<workflow>-<n>`) are referenced from tests and `../plan/traceability.md`. Every criterion must map to at least one automated test (E2E, integration, or LLM eval).

## W1 Onboarding
- **AC-W1-1** Given a new owner with a website listing services and prices, when they submit the URL, then a draft with ≥ 90% of listed services (name, price, duration estimate) is shown for review within 60 s.
- **AC-W1-2** Given a draft, when the owner confirms, then services, hours and staff are created and nothing is created before confirmation.
- **AC-W1-3** Given a Vagaro/Fresha/Square/Booksy/generic client CSV, when imported, then valid rows are created, invalid rows are reported with reasons, and re-importing the same file creates no duplicates.

## W2 Conversational scheduling
- **AC-W2-1** Given Jess is booked 3–5 pm Friday, when the owner asks to book a 2 h service with Jess at 4 pm Friday, then no booking is created, the conflict is explained, and the 3 nearest valid slots are offered as a slot-picker card.
- **AC-W2-2** Given a valid request, when the autonomy setting for "create booking" is "ask me", then a confirmation card is shown and nothing is written until approval.
- **AC-W2-3** Given any AI-created booking, when the owner taps Undo within the undo window, then the booking is removed and any pending customer notification is cancelled.
- **AC-W2-4** Given a staff-role user, when they ask to change another staff member's booking, then the AI refuses with a permission explanation.

## W3 Client knowledge
- **AC-W3-1** Given "Maria is allergic to PPD", when saved, then a fact appears on Maria's profile and in "What I know", tagged sensitive.
- **AC-W3-2** Given Maria has a sensitive fact, when she is booked for a color service, then the booking card shows the warning.

## W4 Operator feed
- **AC-W4-1** Given tomorrow has ≥ 1 h open in a staff schedule and ≥ 1 overdue regular eligible for it, when the daily briefing runs, then a suggestion with a drafted email appears under "Needs your OK".
- **AC-W4-2** Given an approved suggestion, when sent, then exactly one email per recipient is sent even if the job retries.

## W5 Smart waitlist
- **AC-W5-1** Given a waitlist entry matching a cancelled slot, when the cancellation occurs, then an offer is proposed (or sent, per autonomy) to the best match within 2 minutes; the first confirmation books it and others are notified the slot is taken.

## W6 Reminders
- **AC-W6-1** Given a booking 24 h ahead, then a reminder email is sent within 5 minutes of schedule; cancelled bookings never receive reminders.

## W7 Trust
- **AC-W7-1** Every AI action shows a "Why?" explanation listing the inputs used.
- **AC-W7-2** Deleting a memory fact removes it from all future AI context (verified by eval).
- **AC-W7-3** Actions in the `external_or_irreversible` tier can never be set to "just do it" for bulk operations (> 10 recipients).

## W8 Public booking
- **AC-W8-1** Given two customers booking the same last slot concurrently, then exactly one succeeds and the other is offered alternatives.
- **AC-W8-2** A booking is created only after email verification; the confirmation email contains working reschedule/cancel links scoped to that booking.

## W9 Team
- **AC-W9-1** A staff user can see and edit only their own bookings and notes (enforced at API and RLS level).

## Cross-cutting
- **AC-X-1** No user can read or write another tenant's data through UI, API, or AI (cross-tenant suite).
- **AC-X-2** If the LLM provider is unavailable, all non-AI screens remain fully functional.
- **AC-X-3** Every screen follows the design direction the user approved in S39 ([DESIGN.md](../design/DESIGN.md)): colors, type, spacing, radius and motion from tokens only; light and dark equally finished; text contrast ≥ 4.5:1 and icons/borders ≥ 3:1 in both themes; tap targets ≥ 44 px; nothing scrolls sideways at 375 px.
- **AC-X-4** A dev-only gallery shows every component of the kit ([DESIGN.md](../design/DESIGN.md) §4) in each of its states, in light and dark, on the Southside Cuts data of the S39 mockups (real names, prices and times, no lorem ipsum); it is off in production.
- **AC-X-5** The signed-in app has one shell: on phones a bottom tab bar (Home · Calendar · Clients · Chat · More) with the current tab marked; on desktop a sidebar with the same places and a "Pepper" group (What I know, Autonomy, Waitlist). More lists the Pepper group, Services, Team, the settings that used to sit on Home, and the account actions. Each place shows only to roles allowed to open it, and every place is reachable in at most two taps.
- **AC-X-6** Every visible tap target on the shell and Home is at least 44 × 44 px at 375 px (DESIGN D3), checked in the browser.
