# ADR-0060: Client messages, no-shows and honest answers from the chat

- **Status:** Accepted. Pre-approved by the user at the S56a brief on 2026-11-06 ("Pre-approved with your recommendations").
- **Date:** 2026-11-06
- **Builds on:** ADR-0028 (the trust layer), ADR-0029 (tools over the domain), ADR-0040 (draft rules), ADR-0055 (presets; client-visible actions ask), ADR-0059 (domain-written words)

## Context
Phase 12's last build session (playbook S56a) closes the gaps an owner hits in the chat on a normal day. They can't tell a client they're running late. They can't mark a no-show without opening the calendar. A typo in a name ends in "no client matches". A request Pepper has no tool for gets a vague answer. The AI-suggested import mapping was planned for the same session; it moves to S56a.2 (D-1, size).

## Decision
1. **`send_client_message`, one email to one client about one of their visits.** It takes three kinds:
   - `reminder`: only for a visit that hasn't started;
   - `running_late`: 5–60 minutes, from 3 hours before the start to 1 hour after it;
   - `note`: the member's own words, at most 200 characters.

   The visit must be the client's and still booked (`confirmed`). Its staff member's own visits are the only ones staff reach (the booking services' scope).
2. **The words are the domain's except the note (D-2).** The reminder reuses the 24-hour reminder's email. The running-late note is one fixed sentence with the staff member, the minutes and the time. A note is checked at every run (the dry run and the approval). It must hold no link, email address or phone number, and no sensitive value the business remembers about the client (the nudge's `checkNoSensitiveValue`). The email gets the business's name as its signature. These are transactional emails about a booking, so a marketing opt-out doesn't stop them and they carry no unsubscribe footer. A note is not a way to send marketing: it is bound to a visit, and one message goes to one client.
3. **A dial action of its own: `message.client`** (`external_or_irreversible`, ask by default, "just do it" allowed, Undo until it leaves). Hands-off sets it to "do it and tell me", as for every client email. Each message is deduped by visit, kind and words, so a retry never sends twice.
4. **`mark_no_show` through `changeBookingIn` (D-3).** A visit that has started becomes `no_show`. One that hasn't started is refused with the reason. Its dial action is `booking.no_show`: `internal_write`, "do it and tell me" by default. No client is emailed. Undo (for a day, including after the start) puts it back to `confirmed`, also for the staff member who asked (the Undo only: other corrections of an outcome stay owners' and managers'). `cancel_booking`'s guide now points no-shows here.
5. **Migration 0066** widens the three action checks to the sixteen actions.
6. **Close names for typos (guess and confirm).** When `find_clients` finds nobody, the core service compares the search with the names the member may see. It uses an edit distance on each word: 1 for words of 3–5 letters, else 2, scanning the 5,000 most recently changed clients. It returns up to 3 as `suggestions`, never as matches. The guide and the prompt say: ask "Did you mean …?" and act only on the member's answer.
7. **Prompt v8.** The autonomy line names where the member changes it ("on the cards and on the Autonomy page in More", not "in Settings"). New lines say:
   - a typo gets "did you mean";
   - for anything without a tool, say "I can't do that yet" and what happens instead (the calendar screen, the booking page, the reminder that goes anyway). Never promise to do it later.

## Consequences
- An owner messages a client from the chat; no other surface sends free text. SMS (Phase 14) adds a channel to the same tool.
- A note can still say something unkind or wrong. It waits for the owner's OK by default, and the card shows the words.
- The close-name scan is in memory. That is fine for a 1–6 chair business; a trigram index would replace it if a business ever has many more clients.
- The eval business no longer pins moves to "do it and tell me" (`EVAL_WORLD_AUTONOMY` is gone): a move asks, as for every new business.
