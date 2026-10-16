# Business-Model Modules (L2) & Industry Templates (L3)

> Provides: module contract, template schema, Appointments module design · Depends on: L1 core, contracts · Consumed by: AI tools, UI, booking page, insights

## Module contract (L2)
Each module package (`packages/modules/<name>`) exports:
- **Domain services** (pure TS + repositories) with permission and rules checks.
- **AI tools** registered with the tool registry (risk tier, schema, card renderer, evals).
- **Domain events** it publishes/consumes (schemas in `packages/contracts/events`).
- **Insight providers** for the operator feed.
- **Template extension schema** — which fields a template may configure for this module.
Modules never import other modules; cross-module behaviour uses events.

## Appointments module (V1)
- Entities: Service, StaffMember (resource), WorkingHours, TimeOff/Blocks, Booking, WaitlistEntry, ExternalBusyBlock.
- **Rules engine**: rule types — working hours, buffers before/after, minimum notice, maximum advance booking, blackout windows, staff–service eligibility, max bookings per day, learned rules. Each rule Zod-validated and versioned; tenant overrides template defaults.
- **Availability engine**: pure function `(hours, rules, bookings, externalBusy, service, staff?, range) → slots`. Property-tested (no overlaps, respects all rules, deterministic).
- **Concurrency**: booking creation uses a Postgres exclusion constraint on `(staff_id, tstzrange)` so double booking is impossible even under races.
- **Waitlist**: matching + ranking (time window fit, client value, waiting time); offers via messaging with expiry.

## Future modules (designed for, not built)
Classes & Memberships (capacity, passes) · Quotes & Jobs (estimates, approvals, crews, site visits) · Orders (catalog, fulfilment) · Invoicing/Payments (Stripe Connect; deposits in V1.1 attach to Booking via events).

## Industry template schema (L3)
`packages/templates/<industry>` — data only, validated by a Zod schema:
- `terminology` (customer/staff/service labels, singular/plural)
- `modules` enabled (V1: `appointments`)
- `serviceCatalog` defaults (names, durations, buffers, typical price ranges)
- `defaultRules`, `defaultAutonomy`
- `intakeFields` for customer profiles
- `insights` enabled + thresholds (e.g. rebooking interval for haircut = 6 weeks)
- `promptFragments` (domain hints for the AI)
- `onboardingHints` (what to extract from websites/price lists)

V1 templates: `beauty-salon`, `barber`, `nails`, `spa`, `lash-brow`, `personal-trainer`, `massage`, `yoga-pilates-private`. Adding a template requires: schema validation test, onboarding fixture, eval set.

## Tenant customization (L4)
Tenant settings override template defaults (rules, autonomy, terminology tweaks). Stored versioned; changes audited.
