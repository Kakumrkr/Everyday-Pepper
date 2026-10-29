# ADR-0046: Business type at signup, a seeded first week, and activation events

- **Status:** Accepted. Pre-approved by the user at the S45 brief on 2026-10-29 ("Go ahead with your recommendations and complete the session").
- **Date:** 2026-10-29
- **Builds on:**
  - ADR-0018 (industry templates; `tenants.template_id`, "onboarding will make picking a type required in the UI", template prices only pre-fill)
  - ADR-0015 (services, staff and weekly hours), ADR-0017 (staff see their own rows)
  - [V1 playbook](../plan/v1-playbook.md) Phase 10, S45; [scorecard](../plan/scorecard.md) §3 (onboarding completion, time to bookable, time to first booking)

## Context
Until S45 a new business started empty: the owner typed every service, added themselves as staff and entered hours before the booking page offered a single time. Templates carried a service catalog nobody used and no hours at all. Scorecard §3 asks how many sign-ups become bookable and how long that takes, and nothing recorded it.

## Decision
1. **Picking a type is required on the create-business screen (D-4).** Barbershop, Hair salon, Nails and Lash & brow first (the V1 segment), the other four under "More types". `GET /v1/templates` gives each summary a `featured` flag and the size of its menu; the order is the template's data, not code. `POST /v1/tenants` keeps `templateId` nullable (scripts, tests, older clients), and a business without one gets nothing seeded.
2. **Templates carry default weekly hours.** `TemplateSchema.defaultHours` is a `WeeklyHours` (the staff hours' own schema), e.g. Tuesday–Saturday 9–6 for a barbershop. Like prices, they only pre-fill.
3. **Seeded in the creation's transaction (D-2).** `TenancyService` (the api, which may import templates) turns the template into a seed (services, the owner as staff, hours) and core's `createBusiness` runs it in `createTenant`'s `afterInsert`, after the owner's membership. The appointments module's `seedBusinessIn(tx, actor, seed)` writes it through the same row functions and audit entries as the screens, as the owner. Core never imports templates or modules (L1 below L2/L3). A catalog price range whose "to" equals its "from" becomes a single price (services need "to" above "from"). Either the whole business, with its menu, staff and hours, exists or none of it.
4. **The owner is the first staff member (D-2),** linked to their login, with their account's name, offering every seeded service at the template's hours: the shortest path to bookable for a 1–6 chair owner-operator. Renaming, removing services or switching the owner off later are the ordinary edits.
5. **Activation events (D-3).** Two append-only tables, ids and times only (no names, emails, phones, IPs or prices):
   - `activation_events (tenant_id, kind, account_id, occurred_at)`, kinds `business_created`, `bookable`, `first_booking`, each once per business (unique; inserts are `ON CONFLICT DO NOTHING`). Tenant-owned with forced RLS like every business table, in the isolation suite. `account_id` (the owner, an opaque user id) only on `business_created`, which links the business to its owner's sign-up.
   - `signup_events (account_id, occurred_at)`, once per account: global (there is no business yet), listed with the auth tables in the isolation suite. Better Auth's `user.create.after` hook writes it; a failure is logged without the address and never fails the sign-up. An invited staff member's account counts too; S59 tells owners apart by their `business_created` row.
   - `business_created` is written with the business (core `createBusiness`). `bookable` the first time the business has an active service offered by an active staff member with hours: by the seed, or after a change to staff, their services, their hours or a service's return to the menu (appointments `noteBookableIn`). `first_booking` in the transaction of the first booking by staff, the AI, the booking page or a waitlist claim (`noteFirstBookingIn`).
   - Deleting a business removes its events; deleting an account removes its sign-up and clears its id from `business_created`. Nothing reads either table through the app until S59's metrics page.
6. **Time zones.** The list starts with the seven US zones (Eastern, Central, Mountain, Arizona, Pacific, Alaska, Hawaii by IANA id), then every other zone; the browser's zone is chosen at first. Plain names ("Central Time") come in S46.

## Consequences
- A barber is bookable with zero typing; an owner who doesn't take clients themselves turns their staff entry off (S46's checklist will point to it).
- Template hours fit some shops badly; they are editable, and the owner sees them on the booking page at once.
- A new template needs `defaultHours`, `featured` and its schema test (ADR-0018's checklist grows by one line).
- The bookable check runs on staff and hours changes until the event exists, then costs one indexed lookup.

## Tests
`packages/contracts/src/templates.test.ts`, `packages/templates/src/templates.test.ts` (hours valid and long enough, featured four), `apps/api/src/account/template-seed.test.ts`, `apps/api/src/account/tenancy.int.test.ts` (barber seeded and bookable, audited, nothing without a type, all or nothing), `packages/modules/appointments/src/activation.int.test.ts`, `packages/db/src/isolation.int.test.ts`, `apps/api/src/auth.int.test.ts` "AC-W1-10…", `apps/web/lib/time-zones.test.ts`, `e2e/tests/auth.spec.ts` "business type at signup", `e2e/tests/accessibility.spec.ts`, `e2e/tests/screens.spec.ts` (`auth-business`).
