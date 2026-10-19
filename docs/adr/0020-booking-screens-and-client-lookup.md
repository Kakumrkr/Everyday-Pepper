# ADR-0020: Booking screens, finding a client by exact contact, and final outcomes for staff

- **Status:** Accepted (user, 2026-10-19). Proposed by Claude the same day (S15). The lookup itself was decided by the user on 2026-10-17 (ADR-0017 §Consequences). The outcome rule (b) is Claude's recommendation, built by default; the user's confirmation is tracked in `plan/STATUS.md` (Waiting on the user). · **Date:** 2026-10-19 · Builds on ADR-0017 (bookings, clients, member scope), ADR-0014 (the invite lookup policy), ADR-0019 (design system)

## Context
S15 adds booking from the calendar. Two open points from Phase 3 had to be closed first:
- **Staff and clients.** Staff see only the clients they have a booking or waitlist entry with (`clients` `member_scope`, AC-W9-1), and cannot add clients. So a stylist could not book a returning client of a colleague. The user decided that staff may find any client by an exact email or phone, which shows only that client, and that `clients.manage` stays with owners and managers.
- **Booking outcomes.** `completed` and `no_show` could be changed again by anyone who could change the booking (open question 1 since S13). Option (b), final for staff and correctable by owners and managers, was recommended and is built here.

## Decision
1. **Finding a client by exact contact.**
   - **Database (migration 0020).** `current_client_contact()` reads the transaction-local `app.client_contact` (as `current_invite_token_hash()` does for invites). The clients `member_scope` policy's USING gets one more alternative: `current_client_contact()` equals the row's `email` or `phone`. Its WITH CHECK (owners and managers only) and `member_scope_delete` are unchanged, so the match is read-only.
   - **db:** `setTransactionClientContact(tx, contact | null)` and `findClientsByContact(tx, contact)`, at most 10 matches by name (a shared family phone finds everyone with it).
   - **contracts:** `ClientContactSchema` is an email (lowercased) or an E.164 phone, never a part of either. `ClientLookupSchema` is `{ contact }`.
   - **core:** `lookUpClients` needs `clients.read`. It sets the contact in a member transaction and reads the matches.
   - **api:** `POST /v1/clients/lookup` answers 200 `{ clients }`. It is a POST so the email or phone stays out of URLs and access logs.
   - **Booking the client found.** `POST /v1/bookings` and `POST /v1/waitlist` accept an optional `clientContact`. The appointments services set it before they look up the client (`findClientToBook`), so staff can book a client they found by exact contact. The database still decides: the contact must match the client's row, and the staff scope on bookings and waitlist entries is untouched. Once booked, the client is the staff member's client like any other.
   - **Tests.** The isolation catalog has the new policy text. A db integration test covers: matches by phone (shared) and email; a staff member without a staff member; another business finds nothing; writes and deletes refused; cleared at once with `null`. Domain tests cover: no partial matches, booking only with the right contact, never for a colleague, and the waitlist.
2. **Outcomes rule (b).** `canChangeStatus(from, to, correctsOutcomes)`: `cancelled` stays final for everyone; `completed` and `no_show` are final unless the actor reaches every booking (`bookings.manage` scope `all`, so owners and managers). `changeBooking` passes that in; staff get `409 booking_not_changeable`.
3. **Screens (web, S15).**
   - Calendar header: **New booking** for members with `bookings.manage` who have a bookable staff member (staff: the one linked to their login).
   - **New-booking sheet** (Radix Dialog, `@radix-ui/react-dialog` 1.1.23):
     - **Client:** owners and managers search by name or email (`GET /v1/clients?search=`) or add a new client. Staff type an exact email or phone; local US numbers become E.164.
     - **Service, staff member and day:** the free times come from `GET /v1/availability`, or the member types another time.
     - **Booking:** one idempotency key per opening of the sheet.
     - **A refused time (409 `slot_unavailable`):** the three nearest free times as chips, and **Add to the waitlist** with a suggested window: the wanted day, from the wanted time for two hours, which the member can edit.
   - **Booking sheet.** Bookings the member sees in full open a sheet with the details and what the status allows: **Mark done** and **No-show** once the booking has started, **Move** (same picker; owners and managers may move to another staff member who offers the service), and **Cancel booking** (with a confirmation). A refused move shows the alternatives too. The api checks everything again.
   - **Helpers.** Pure helpers live in `apps/web/lib/booking.ts` and are unit tested. The browser reads with `fetchJson` and writes with `sendJson`, which now keeps a failure's body for the 409 alternatives.

## Consequences
- Staff can confirm whether an email or phone belongs to a client of the business, one exact value at a time. They are trusted team members invited by an owner, and the api's general rate limiting arrives with Phase 11 hardening. If abuse becomes a concern, audit lookups or rate-limit `POST /v1/clients/lookup` per member.
- A client found this way stays invisible to the staff member until they book them. Booking makes the client theirs through the existing `bookings` clause.
- The contact setting widens only reads of `clients`, only inside the transaction that sets it, and only for an exact value. A service must never set it from data it read; only from what the member typed. The function's comment and `setTransactionClientContact` say so.
- Owners and managers can still correct outcomes. When payments and commissions arrive, corrections may need a reason and their own audit action.
- Moving a booking offers free times that exclude the booking's own time (availability does not know which booking is being moved). The "other time" field covers a move that overlaps the old time, which `changeBooking` allows.

## Alternatives considered
- **A SECURITY DEFINER lookup function:** rejected as in ADR-0012/0014. FORCE RLS still applies unless its owner is a superuser, and a policy keeps the rule visible to the isolation suite.
- **Letting staff book any client id without a contact:** the booking would show them a client they never proved they know, and ids appear in URLs and logs.
- **`GET /v1/clients/lookup?contact=`:** puts personal data in URLs and access logs.
- **One shared sheet driven by the URL (`?booking=<id>`):** deep-linkable, but it needs the page to load the booking again and adds routing state. Per-block dialogs are simpler for now; revisit with the week view.
