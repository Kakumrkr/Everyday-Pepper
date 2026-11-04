# ADR-0052: Staff walk-in clients, and paging the client list

- **Status:** Accepted (built in S50.2). Approved by the user at the S50.2 brief on 2026-11-03 ("Go ahead with your recommendations and complete the session"; D-1 A, D-2 A, D-3 A, D-4 yes).
- **Date:** 2026-11-03
- **Builds on:**
  - ADR-0017 (clients, bookings, the member scope: staff read only clients they have a booking or waitlist entry with, and never write), ADR-0020 (finding a client by exact contact)
  - ADR-0051 (deleted clients keep a row as "Deleted client")
  - [V1 playbook](../plan/v1-playbook.md) Phase 11, S50.2; [scorecard](../plan/scorecard.md) C6, C11, C13

## Context
A barber with a walk-in in the chair can only book a client the owner has added, or one they find by exact email or phone. Adding a client is `clients.manage` (owners and managers), and the clients `member_scope` policy lets only them write. The rule behind it stays right: staff must not build or browse the business's client list. A walk-in is different: the client exists because of this booking with this staff member.

The Clients list showed the first 50 by name ("search to narrow it"); after an import of 1,000 clients most of them were out of reach, and a phone number couldn't be searched.

## Decision
1. **A walk-in is created with its booking, never alone (D-1 A).** `POST /v1/bookings/walk-in` takes the booking's fields with `client: { name, email?, phone? }` instead of `clientId` (`bookings.manage`, as any booking). In one transaction, after the time is found free and just before the booking is written:
   - owners and managers add the client as they would on the Clients screen;
   - staff add them through `create_walk_in_client(id, name, email, phone)` (the id from the app, UUIDv7 as every id), a SECURITY DEFINER function: it refuses a transaction without a user or a user with no staff member in the business (42501), writes the client (`source` `team`) and names it in the transaction's `pepper.walk_in_clients`;
   - a deferred constraint trigger checks at commit that every client so named has a booking; otherwise the commit fails (23514). A client is never left behind by a refused time, a crash or a direct call;
   - the client then belongs to the staff member through the booking, exactly as before: the `member_scope` policies are unchanged, and other staff don't see the client.
   Audited as `client.created { source: 'team', walkIn: true }` (no details) before `booking.created`.
2. **An existing client is booked, not duplicated (D-2 A).** With an email that is already a client's (one per business), that client is booked; without an email, a phone that exactly one client has books that client. The match is the one `POST /v1/clients/lookup` already gives staff (ADR-0020), so nothing new is revealed; the walk-in's name doesn't change the client found.
3. **The idempotency key covers the pair.** A retry with the same key and the same service, staff member and time returns the first booking and adds no second client.
4. **The client list pages by a cursor (D-3 A).** `GET /v1/clients` answers `{ clients, nextCursor }`: by `lower(name), id`, `limit` (default 50) at a time; `after=<client id>` continues after that client. The cursor is the last client's id, so the address never carries a name, email or phone. A search also matches part of a phone number: its digits (at least 3, any format) against the stored E.164 number. The AI's name-only lookup is unchanged.
5. **Names on visits in one request.** `GET /v1/clients/names?ids=<id>,<id>` (at most 100, ids only) answers the names of the clients the member may see, a deleted one as "Deleted client" with `deleted: true`. A GET, as the web server reads it while drawing the calendar (the api refuses a POST from anywhere but the app's own pages). The calendar uses it instead of one profile request per booking (up to 60 before), and the booking sheet's new Client row links to the profile only when the client isn't deleted.

## Consequences
- Staff book a walk-in from the chair; the owner sees the new client on the Clients screen, the staff member only through their bookings.
- The definer function widens the app role's writes only to inserting one client inside a transaction that must also book them; the isolation suite covers the function, the trigger and that other staff still don't see the client.
- A cursor whose client was merged away (its row is gone) ends the list early; the next load starts again from the top.
- Not covered: staff adding a client without a booking (waitlist-only walk-ins), editing a walk-in's details (still owners and managers).
