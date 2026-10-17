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
- **Rules engine**: rule types — working hours, buffers before/after, minimum notice, maximum advance booking, blackout windows, staff–service eligibility, max bookings per day, learned rules. Each rule Zod-validated and versioned; tenant overrides template defaults. Built in S11 ([ADR-0016](../adr/0016-booking-rules-and-availability.md)): working hours, buffers and eligibility are base data (ADR-0015); slot interval, notice, advance, daily cap and blackout windows are stored rules, per business or staff member (staff → business → template → platform default); learned rules come in Phase 7.
- **Availability engine**: pure function `(hours, rules, bookings, externalBusy, service, staff?, range) → slots`. Property-tested (no overlaps, respects all rules, deterministic). Built in S11 as `availableSlots` (ADR-0016): local hours → UTC across DST with `Intl`, buffers may reach outside hours, 10k-case property tests with a brute-force oracle.
- **Concurrency**: booking creation uses a Postgres exclusion constraint on `(staff_id, tstzrange)` so double booking is impossible even under races.
- **Bookings** (S12, [ADR-0017](../adr/0017-bookings-clients-and-waitlist.md)): every booking passes the availability engine while its staff member is locked; `booking_occupancy` with an exclusion constraint makes double booking impossible; owners and managers may override hours and rules (never an overlap); a refused time returns the 3 nearest slots; idempotency keys for retries.
- **Waitlist**: matching + ranking (time window fit, client value, waiting time); offers via messaging with expiry. The model (entries with local-time windows, derived expiry) and its API are built in S12 (ADR-0017); matching and offers in Phase 8.

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
