# ADR-0032: The four week-one tools and the facts behind *Why?*

- **Status:** Accepted (user, 2026-10-21: "Go ahead with your recommendations, ADR is pre-approved", at the S26b Session Brief; drafted by Claude in S26b). The user chose, at that brief:
  - a staff member removing a colleague's blocked time is `forbidden`, not `not_found`, because they can see it in the calendar; clients and to-dos they can't see stay `not_found`;
  - explanation facts are filled in this session;
  - no new card kinds and no new Playwright journeys.

  The rest are Claude's defaults below.
- **Date:** 2026-10-21
- **Builds on:** ADR-0026 (tasks), ADR-0028 (trust layer), ADR-0029 (tool registry), ADR-0031 (cards, *Why?*), [PCR-004](../plan/changes/PCR-004.md), the [Phase 6 playbook](../plan/phase-6-playbook.md) principles 1, 3, 9, 10 and §7 "S26b".
- **Amends:** ADR-0029 §2 (fourteen tools; `get_day` version 2) and ADR-0028 §6 (an action's explanation takes its facts from the domain's preview).

## Context
S26's review of the tools' guides found requests owners make in the first week that the AI could not answer: "When is Maria next in?", "What are my to-dos?", "Mark the Maria call done", "Remove Jess's lunch block". PCR-004 added S26b so these tools are evaluated with the rest in S27.

*Why?* also showed only the request, the steps and the dial's decision. The explanation's `facts` were empty since S24, so the sheet could not say what the domain had actually checked (playbook principle 9).

## Decision
1. **Four tools, each a thin adapter over a transaction-taking domain service.**
   - **`find_client_bookings`** (read, `clientId`):
     - It returns the next 5 bookings (not cancelled), earliest first, and the last 3 (any status), latest first.
     - It uses a new db query `listClientBookings` with no date window, nearest first both ways, and appointments `listClientBookingsIn`. The 62-day window of `listBookingsIn` would have missed a client last seen ten weeks ago.
     - Staff get their own bookings only. A client the member can't reach is `not_found`.
     - The card is the existing `booking` card for the next appointment.
   - **`list_todos`** (read, `whose: mine | team`):
     - It returns up to 20 open to-dos, due first: id, title, local due date and time, overdue, and whose it is ("you", a staff member's name, a member's first name, "the team").
     - Staff get only the to-dos the database's member scope shows them (assigned to them or created by them).
     - Titles go through `redactContacts`, because the to-do screen allows contact details in a title.
     - A to-do the AI created (`source` other than `manual`) labels the answer as untrusted text. Its words may come from an earlier turn's pasted message, so they come back as data and make external actions ask (principle 10).
   - **`complete_todo`** (write, dial `task.create`, `todoId`):
     - It marks an open to-do done through core `completeTaskIn`. That uses `changeTaskIn`, the screen's own path, now taking a transaction.
     - A to-do already done is `not_changeable` (`TaskNotOpenError`). One the member can't see is `not_found`.
     - Undo is `reopenTaskIn`. It runs only while the to-do is still done and unchanged since; its `updatedAt` right after completion is the inverse. Otherwise it is `changed_since`.
     - The fingerprint covers the to-do's `updatedAt`, so an edit between proposal and approval makes it stale.
   - **`unblock_time`** (write, dial `time.block`, `timeOffId`):
     - It removes one time-off entry, found with db `findTimeOff` and appointments `getTimeOffIn`.
     - It takes only a time-off id, so it can never remove a booking: a booking's id is `not_found`.
     - The whole entry goes, and the summary says its whole span. For a multi-day block, the guide tells the model to block the part that stays again.
     - Undo puts the same span back with `addTimeOffIn`.
     - `get_day` (now version 2) lists each blocked time's id in its data. The day card is unchanged.
2. **Dial actions.** `complete_todo` uses `task.create` and `unblock_time` uses `time.block` (PCR-004). There is no new action and no migration.
3. **Guides tell the model when to use these instead of `get_day` or Undo.**
   - `find_client_bookings` "not with a name (use find_clients first) … not to see everyone on a day (use get_day)".
   - `complete_todo` and `unblock_time` "not to take back what Pepper just did (the member taps Undo on its card)".
   - `unblock_time` "never touches bookings".
   - The guide lint holds all fourteen. Their examples became 8 more generated eval cases with scripted cassettes. The eval world gained an open to-do and Jess's lunch block.
4. **Explanation facts, from the domain.**
   - `Performed.facts` holds codes with flat values that the tool's own run established:
     - `slot_was_free` (create, move);
     - `staff_chosen` (create with nobody named);
     - `not_started` (cancel);
     - `bookings_inside` (block);
     - `bookings_untouched` (unblock);
     - `reminds` (a to-do with a due time);
     - `todo_was_open` (complete).
   - The runner passes them as `ActionPreview.facts`. When a preview gives facts, they are the stored explanation's facts. A stale approval's fresh preview brings its own.
   - `AiWhy.facts` is optional and additive. The api passes only flat, contact-free facts and leaves any other out rather than failing the view.
   - The *Why?* sheet words them under "What I checked" (`factLine` in `@pepper/ui`), and skips a code it doesn't know.
   - No existing tool's version changes: facts are not part of the fingerprint, so stored proposals still approve.
5. **Cards without a new kind.**
   - `changeRows` reads the two new shapes from the sides: a `task.create` change with a `before` is a completion (open → done), and a `time.block` change whose `after` says `blocked: false` is an unblock (its whole span → "Free to book").
   - The chat's empty state suggests "What's on my to-do list?" (HAX G1).
6. **The hostile fake attacks every new tool.**
   - Another business's ids and smuggled fields are attacked for each tool.
   - Specific attacks: a booking's id as a to-do or as blocked time, a to-do's id as blocked time, and an email where a client id goes.
   - The targets come from one helper (`hostileTargets`), so the three hostile suites aim at the same records.
   - The "ask" suite now covers every write tool in the registry.

## Consequences
- **Gains:**
  - Owners can ask the four week-one questions, and staff get the same, limited to what their screens show (D-4).
  - Each new write is proven: the preview equals the execution, Undo restores the state (or refuses when someone changed it since), the role matrix holds, and another business's ids answer `not_found`.
  - *Why?* now says what was checked, from records, not prose (D-2).
- **Costs and risks:**
  - **A bigger static prefix.** Fourteen tool definitions add about $0.05 a case to the cost guard's worst case. One run of 30 one-turn cases no longer fits the $1.50 cap at every step, 25 does. S27 runs a set in chunks of at most 25, or calibrates the 3-characters-a-token estimate first.
  - **Tool summaries reach the model unlabelled.** A to-do's title echoed in `complete_todo`'s summary is not marked untrusted; the id first comes from `list_todos`, which labels the turn. Logged for S27's security review.
  - **Undoing an unblock** brings the block back even if someone booked into the freed time meanwhile. The booking stays inside it, as with `block_time`.
  - **`get_day` changed its answer** (block ids). No cassette was recorded yet, so nothing is invalidated.

## Alternatives considered
- **`listBookingsIn` with a window for a client's visits:** no new query, but a client seen every ten weeks would show no "last visit".
- **`unblock_time` by staff member and date:** no id lookup, but ambiguous with two blocks on one day and with blocks spanning days.
- **A to-do list card:** nicer in the chat, but a new card and journey for what Home's To-dos card already shows. The chat answers in text.
- **Facts in the fingerprint:** a stale approval for any changed fact, but facts are the preview's explanation, not the state the member approved.
- **`not_found` for a colleague's blocked time:** consistent with clients and to-dos, but untrue: staff see the block in the calendar, and D-4 says the AI explains a refusal.
