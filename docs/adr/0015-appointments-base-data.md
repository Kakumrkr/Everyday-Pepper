# ADR-0015: Appointments base data — services, staff, hours and time off

- **Status:** Accepted (user, 2026-10-17, S10 Session Brief: four decisions and the price format below) · **Date:** 2026-10-17 · Builds on ADR-0010 (RLS), ADR-0013 (roles, audit log)

## Context
Phase 3 builds the appointments module: rules, availability, bookings and a waitlist on top of what a business offers, who can be booked and when they work. Those base records come first (S10). They are tenant data, read by everyone in a business and changed by owners and managers. Staff need to block their own time without being able to rearrange the business.

## Decision
1. **A new L2 package, `@floty/appointments`** (`packages/modules/appointments`), holds the domain services: services, staff, hours, time off; later the rules and availability engines, bookings and the waitlist. It depends on contracts, db and core only. Tables and repositories stay in `@floty/db` (no database access outside it). The api calls the module; Phase 6 AI tools will call the same functions.
2. **Tables** (all tenant-owned, forced RLS, `tenant_isolation`, in the isolation suite):
   - `services`:
     - Duration 5–720 minutes and buffers 0–240 minutes.
     - A price shown as **"from" `price_from_cents`, optionally up to `price_to_cents`** (integer cents; "to" requires "from" and must be higher). With no price, none is shown.
     - The name is unique per business, case-insensitively.
     - An `active` flag: services are deactivated, not deleted, because bookings will refer to them.
   - `staff_members`: a display name, a calendar colour (`#rrggbb`), `active`, and an optional `membership_id`.
   - `staff_services`: the services a staff member offers.
   - `working_hours`: ISO weekday, plus start and end in minutes after **local** midnight.
   - `time_off`: an exact UTC span (at most 366 days), with who entered it.
3. **A staff member is separate from a login, and optionally linked to one membership** (one staff member per membership). A stylist who never signs in can still be booked. A linked member's "own" records are that staff member's. Removing the member unlinks the staff member and keeps everything else (`ON DELETE SET NULL (membership_id)`).
4. **References stay inside the business.** A foreign key check does not apply RLS, so a reference by id alone could point at another business's row whose id is known. Every reference between tenant tables is a composite key on `(tenant_id, id)`: `staff_services` → staff and service, `working_hours` and `time_off` → staff, `staff_members` → membership. Parents carry `UNIQUE (tenant_id, id)`. Tests try each reference across businesses and expect `23503`. **This is the rule for every new tenant table.**
5. **Working hours are wall-clock time in the business's time zone.** "Tuesday 09:00–17:00" stays 09:00–17:00 across daylight-saving changes. The availability engine (S11) turns them into UTC instants for a given date.
   - Intervals on one day may touch but not overlap. The contracts check this first; an exclusion constraint (`btree_gist`) makes it hold under races. Overnight shifts are not supported (end after start, same day; `24:00` allowed).
   - `PUT /v1/staff/:id/hours` replaces the whole week under a lock on the staff member, so concurrent edits serialise.
6. **Permissions** (new matrix rows):
   - `staff.read`: everyone.
   - `staff.manage` and `hours.manage`: owners and managers.
   - `time_off.manage`: owners and managers for anyone; **staff for their own linked staff member only** (scope `own`, checked against the link read in the same transaction).
   - Staff cannot change their own weekly hours.
   - `services.read` and `services.manage` already existed.
7. **Audit:**
   - `service.created`/`service.updated`: all service fields. A service describes the business, not a person.
   - `staff_member.created`/`staff_member.updated`: active, linked user and service ids, **never the display name or colour**. A name-only change is therefore not audited.
   - `working_hours.replaced`: the week before and after.
   - `time_off.created`/`time_off.deleted`: whose and when.
   - An unchanged save writes no entry.
   - Time off has **no free-text reason**: it would be personal data.
8. **Endpoints:**
   - `GET/POST /v1/services` and `PUT /v1/services/:serviceId`.
   - `GET/POST /v1/staff` and `PUT /v1/staff/:staffMemberId`.
   - `GET/PUT /v1/staff/:staffMemberId/hours`.
   - `GET/POST /v1/staff/:staffMemberId/time-off` and `DELETE …/time-off/:timeOffId`.
   - PUT replaces every field. New error codes: `service_not_found`, `service_name_taken`, `staff_member_not_found`, `staff_member_link_taken`, `time_off_not_found`; a login of a non-member gives `member_not_found`.

## Consequences
+ The base data for availability and bookings exists, isolated, permission-checked and audited, with database constraints behind every contract rule.
+ Composite keys close a cross-tenant gap that RLS alone leaves open for references; the pattern carries over to bookings.
− `btree_gist` must be creatable by the migration role (a trusted extension: the database owner can; Compose uses the superuser). Bookings need it anyway.
− Time off is visible to the whole team (its span only, no reason). If a business needs it private, a later permission can narrow it.
− A service name could mention a person ("Cut with Jess"); it is audited like any service name.
− No delete endpoints yet: deactivate instead. Deleting unused records can come with bookings, once "unused" can be checked.

## Alternatives considered
- **Every staff member is a membership** (`memberships.staff_member_id` in the original data model): rejected by the user. Owners must be able to list a stylist who never signs in.
- **Domain services in `@floty/core`**: rejected by the user. Appointments is an L2 module, and core stays the platform layer.
- **Hours as UTC instants**: rejected, because they would shift by an hour at every daylight-saving change.
- **Single-column foreign keys plus an app-level tenant check**: rejected. A missed check would be a silent cross-tenant link; the composite key makes it impossible.
- **A single price, or a range only**: the user chose "from" with an optional "to", which covers fixed prices, "from $40" and "$40–60".
