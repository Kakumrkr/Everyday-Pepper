# Personas & Workflows

## Personas
| Persona | Description | Key needs | Role |
|---|---|---|---|
| **Owner** | Runs a 1–10 person salon, barbershop, spa, studio or training business; works on the floor; mostly on a phone | Speed, fewer no-shows, full books, control | `owner` |
| **Manager / front desk** | Handles schedule and clients for the team | Fast rescheduling, client lookup | `manager` |
| **Staff member** (stylist, therapist, trainer) | Serves clients | See own schedule, notes, block personal time | `staff` (own data only) |
| **Customer** (end client) | Books through the public booking page | Easy booking, reminders, self-reschedule | No account (guest + email verification) |

## V1 workflows
### W1 — Zero-setup onboarding
Owner signs up → picks business type (template) → provides website URL / Google Business profile / price-list photo → AI drafts services, prices, durations, hours, staff → owner reviews a summary card and confirms/edits → optional client CSV import (Vagaro/Fresha/Square/Booksy/generic) → optional Google Calendar connect → booking page link ready.

### W2 — Conversational scheduling
Book, reschedule, cancel, check availability, "what does tomorrow look like?", block time. AI replies with cards; conflicts produce alternatives. Every write goes through rules + autonomy dial.

### W3 — Client knowledge
Look up a client; add notes and preferences ("Maria is allergic to PPD"); see visit history; memory surfaces relevant facts when that client is booked.

### W4 — Operator feed
Daily briefing + continuous feed: today's bookings, open slots, overdue regulars, no-show patterns, staff overload. Each item has an approve/dismiss action; approved drafts (e.g. rebooking emails) are sent via the messaging layer.

### W5 — Smart waitlist
Customer or owner adds a waitlist entry (service, staff, time windows). On cancellation, the system ranks matches and proposes an offer (autonomy dial decides auto-send vs approval); first to confirm gets the slot.

### W6 — Follow-ups and reminders
Appointment confirmations and reminders to customers (email); owner to-dos ("remind me Monday to order color") as tasks with due dates.

### W7 — Trust controls
Autonomy settings page; per-action "Why?" panel; undo from feed/history; "What I know" page to view/edit/delete memory and learned rules.

### W8 — Public booking (customer)
Branded page → pick service → staff (or any) → time → name/email → email verification code → confirmation email with reschedule/cancel link. Respects rules, buffers and staff calendars.

### W9 — Team & permissions
Invite staff, assign roles and services, set individual hours.
