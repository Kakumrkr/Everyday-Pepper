# ADR-0051: Merging and deleting clients

- **Status:** Accepted (built in S50). Approved by the user at the S50 brief on 2026-11-03 ("Go ahead with your recommendations and complete the session"; D-1 A, D-2 A, D-3 A, D-4 yes).
- **Date:** 2026-11-03
- **Builds on:**
  - ADR-0017 (clients, bookings, the member scope), ADR-0020 (finding a client by exact contact), ADR-0021 (audit entries name changed fields only)
  - ADR-0034 (memory: facts go with their subject, forget everywhere), ADR-0049 / ADR-0050 (import rows, external ids, undo)
  - [V1 playbook](../plan/v1-playbook.md) Phase 11, S50; [scorecard](../plan/scorecard.md) C11, C13

## Context
An import leaves duplicates ("Dee Hart" from the old tool, "Dee H." from the booking page), and a client may ask to be forgotten. Bookings and waitlist entries refer to their client without a cascade (deleting a client with history was impossible), memory facts keep their subject for life (migration 0039), and episodes are written once. The owner's revenue history (S73 reports) must still add up after a client goes.

## Decision
1. **Owners and managers only** (`clients.manage`). The api refuses staff before the service; the member scope refuses their writes; the two new database functions refuse any transaction without an owner or manager (42501), and a client outside the transaction's business (P0002).
2. **Merge: the client kept is chosen, the other goes (D-3).** `POST /v1/clients/:id/merge { otherClientId }` keeps `:id`. In one transaction, with both rows locked in id order:
   - visits (bookings), waitlist entries and offers, external ids (`client_import_refs`) and import rows move to the client kept; import rows of both stop counting as "created by the import", so an import's Undo never removes the merged client;
   - notes (facts) move: the guard trigger allows exactly the move the transaction names in `pepper.client_merge` (`<from>><to>`), nothing else; where both have an active fact with the same key, the kept client's stays and the other's is deleted: forgotten as any deleted fact's is, unless it held the same value (then nothing is scrubbed, as the value is still remembered);
   - every member's episodes naming the other name the kept client (`client_merge_episodes`, a definer function: episodes are otherwise never updated);
   - the other's open suggestions go, pending proposals about them expire (they would act on a client who no longer exists), and the insights run again (ADR-0039);
   - empty email, phone and birthday are filled from the other, tags combined (the kept client's first, no case repeats, at most 20), and an email opt-out from either stays (the earlier one);
   - then the other row is deleted.
   Two clients with confirmed visits at the same time are two people: `409 client_merge_overlap`. No undo; the confirm shows what moves. Audited on the client kept as `client.merged { mergedClientId, moved: { visits, waitlistEntries, notes } }`.
3. **Delete: forget the person, keep the visit (D-2 A).** `DELETE /v1/clients/:id`:
   - while the client has upcoming confirmed visits: `409 client_has_upcoming_visits` (cancel or move them first);
   - otherwise `client_forget` (definer) deletes every member's episodes naming them, deletes the booking page's remembered browsers for their email, and scrubs their name, email and phone from the business's stored conversations written since the client was added (never older text, as with facts, so adding and deleting a client can't erase a word from older chats);
   - their facts and the facts about their visits are deleted (each one's trigger scrubs its value); suggestions, waitlist entries and offers, and external ids go; pending proposals about them expire; their import rows lose every detail, their link and their matching hash; their past bookings' reschedule/cancel links stop working;
   - the row stays, as "Deleted client" with no email, phone, tags or birthday and `deleted_at` set (a check refuses details on a deleted row). Past visits keep it, so counts and money still add up; nothing lists, searches, finds by contact, books, reminds, suggests (insights skip their visits) or imports onto it again.
   Audited as `client.deleted { pastVisitsKept, notesForgotten }`.
4. **Counts first.** `GET /v1/clients/:id/records` gives `{ upcomingVisits, pastVisits, waitlistEntries, notes }` for the confirm sheets.
5. **Tags and birthday editable.** `ClientInputSchema` takes optional `tags` and `birthday` (left out, an edit keeps them; `null` clears the birthday); `client.updated` may name `tags` and `birthday`.

## Consequences
- Duplicates from an import are one tap away from one client with one history; Undo of that import keeps the merged client.
- A deletion is real for everything Pepper reads back (lists, the AI's tools, memory, chats, the booking page) while visits and money stay countable.
- Not covered, for later: booking emails already queued when the client is deleted still go out (their payload is cleared once sent); AI receipts (`ai_action_executions`) already decided may still name the client in their preview; a phone written differently in a chat ("(555) 123-4567") isn't matched by the scrub; full export and account deletion are S51.
- The definer functions widen what the app role may do only to owners and managers, inside their own business, and only for these two steps; the isolation suite covers both.
