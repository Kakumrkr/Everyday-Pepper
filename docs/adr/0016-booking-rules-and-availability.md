# ADR-0016: Booking rules and the availability engine

- **Status:** Accepted (user, 2026-10-17). Four decisions were made by the user at the S11 Session Brief: store rules now, `Intl` for time zones, the defaults, and blackout windows as local dates; the rest was accepted with this ADR. · **Date:** 2026-10-17 · Builds on ADR-0015 (base data), ADR-0013 (roles, audit log), ADR-0010 (RLS)

## Context
Phase 3b turns a business's base data (ADR-0015) into bookable times. Owners need limits beyond weekly hours: how much notice they want, how far ahead people may book, the steps start times fall on, a daily cap, closed days. Templates (S13) will ship defaults for these, and learned rules (Phase 7) will add more later. The engine has to be pure so that the booking page, the calendar, and the AI tools (Phase 6) all get the same answer, and so that it can be property-tested. Times are wall-clock hours in the business's time zone (ADR-0015), so the engine has to get daylight-saving changes right.

## Decision
1. **Rule types (contracts `RuleSchema`):**
   - `slot_interval`: 5, 10, 15, 20, 30 or 60 minutes. Each divides an hour, so the start-time grid survives DST changes, which are whole hours in the US.
   - `minimum_notice`: 0 minutes to 30 days.
   - `maximum_advance`: 1 to 730 days.
   - `max_bookings_per_day`: 1 to 100.
   - `blackout_window`: local dates `YYYY-MM-DD`, both ends included, at most 366 days (user, S11).

   The other listed "rules" are already base data, and the engine reads them from there instead of storing them twice:
   - working hours come from `working_hours`;
   - buffers come from the service;
   - staff–service eligibility comes from `staff_services`.
2. **Versioned.** Each rule carries `version` (now `1`): the schema version of its `params`. The contracts accept only the current version. A later version ships with an upgrade function that rewrites stored rules. A stored rule the code cannot parse fails loudly (`rowsToRules`); it is never ignored.
3. **Scope and precedence.** A rule applies to the whole business (`staffMemberId: null`) or to one staff member. Precedence, in `resolveRules`:
   - For single-valued rules: the staff member's own rule wins, then the business's rule, then the template default (S13), then the platform default.
   - Blackout windows add up: the business's closed days and the staff member's own both apply.

   A business, and each staff member, has at most one rule of each single-valued type. Blackout windows may repeat.
4. **Platform defaults** (user, S11): 15-minute steps, 2 hours' notice, up to 90 days ahead, no daily cap.
5. **Storage: `booking_rules`.**
   - Tenant-owned: forced RLS, `tenant_isolation`, and listed in the isolation suite.
   - Columns: `type`, `version`, `params jsonb`, and an optional `staff_member_id`. The staff member is a composite foreign key on `(tenant_id, staff_member_id)`, cascading when the staff member is deleted. A business-wide rule leaves it NULL, and the key is then not checked (MATCH SIMPLE).
   - The database checks that the type is known, the version is at least 1, and `params` is an object. The contracts validate `params` itself on every write and read.
   - A partial unique index `(tenant_id, type, staff_member_id) NULLS NOT DISTINCT WHERE type <> 'blackout_window'` makes "one per scope" hold under races.
6. **Whole-set replace.**
   - `PUT /v1/rules` replaces the business's rule set, like a staff member's week.
   - It runs under a per-business advisory lock, because the set may be empty and then there is no row to lock. Concurrent changes therefore serialise, and the audit trail chains exactly.
   - Every staff member a rule names must be the business's own; otherwise it answers 404 `staff_member_not_found`, before the foreign key would.
   - `GET /v1/rules` returns the rules sorted: business rules first, then by staff member, type, and first day.
7. **Permissions:** `rules.read` for everyone (staff see when the business can be booked), and `rules.manage` for owners and managers.
8. **Audit:** `booking_rules.replaced` on the tenant, with the whole set before and after. Rules hold only durations, counts and dates (no personal data). An unchanged save writes no entry.
9. **Time zones with `Intl`, no date library** (user, S11). Node 22 has no `Temporal`. `zoned-time.ts` converts wall-clock time to UTC using the offsets a day either side; real zones change at most once in that span.
   - A time **repeated** by fall-back means its earlier instant, as in Temporal's "compatible" mode.
   - A time **skipped** by spring-forward means **the moment of the change** (02:30 → 03:00 EDT), not Temporal's "one gap later" (03:30). The property tests showed that "one gap later" is not monotonic: 02:01 lands after 03:00. With it, hours that do not overlap on the clock, such as 01:00–02:50 and 03:00–04:00, would overlap in real time. Mapping to the moment of the change keeps the conversion monotonic.
10. **Availability engine.** `availableSlots(query)` is a pure, deterministic function. It takes the business's time zone, `now`, a range `[from, to)` of at most 62 days, the service, and each candidate staff member's hours, time off, bookings, outside busy time and resolved rules. It returns `{ staffMemberId, start, end }` slots sorted by start, then staff member id. All instants are epoch milliseconds and all intervals are half-open. A slot is offered when:
    - the service is active, and the staff member is active and offers it;
    - the appointment fits inside one working interval, read in local time on that day, so DST makes the interval longer or shorter in real time;
    - its start is on that interval's grid (start + k × step) and inside `[from, to)`;
    - the time it occupies (the appointment plus the service's buffers) overlaps no time off, no outside busy time, and no other booking's occupied time, that booking's own buffers included;
    - **buffers may reach outside working hours.** A 10-minute preparation does not push the first slot to 09:10;
    - it starts at least the minimum notice after `now`, and strictly less than the maximum advance after `now`;
    - its local day is not blacked out, and has fewer bookings (counted by the local day each starts on) than the daily cap.
11. **Tests.**
    - fast-check property tests run 10,000 cases each, across seven US zones, including Phoenix and Honolulu, which keep standard time. Times cluster around DST changes, and `now` often falls on 5-minute marks so the limits are hit exactly. The properties:
      - every offered slot passes an independent checker;
      - a brute-force enumeration finds no slot the engine missed;
      - the output does not depend on input order.
    - `zoned-time` has its own round-trip, gap and monotonicity properties.
    - Mutation checks (buffer dropped, off-grid starts, blackout ignored, cap and advance limits off by one, notice exclusive) each make the properties fail.

## Consequences
- **S12 (bookings):** the exclusion constraint should cover a booking's *occupied* range, buffers included, so the database and the engine agree. Callers must pass every booking that starts on a local day the range touches, or the daily cap is undercounted.
- **S13 (templates):** templates supply `Partial<RuleDefaults>` to `resolveRules`. Template defaults are not stored per business; changing a template's default changes every business that has not overridden it.
- **Phase 7 (learned rules):** these will need a `source` column, or a separate table, and their own types. The data model lists `source` for rules; it is not built yet.
- Non-US zones with 30-minute DST changes (e.g. Lord Howe) would still give correct instants, but a 60-minute step could then fall off the local half hour. Out of scope for the US-only V1.
- Buffers outside working hours mean preparation or clean-up can happen before opening or after closing. An owner who does not want that can shorten the hours.
