# ADR-0038: "What I know", the Remembered chip and visit notes on screens

- **Status:** Accepted. Pre-approved by the user at the S32a brief on 2026-10-23 ("Go ahead with your recommendations, ADR is pre-approved").
- **Date:** 2026-10-23
- **Builds on:** ADR-0034 (memory store, forget everywhere, who reaches what), ADR-0035 (facts in the AI, `$fact` references), ADR-0036 (forget takes recalled answers), ADR-0037 (episodes and learned rules), ADR-0030 (chat events). Phase 7 playbook D-11, D-14, D-15, D-16.

## Context
S29–S31 built the memory store and gave it to the AI. Members could not yet see or correct what Pepper remembers, except through the chat. Phase 7e (S32) adds that on screens:
- "What I know";
- the client profile and the booking sheet;
- a chip under each answer that used memory.

The rules already in place must hold:
- staff read only what the member-scope policies allow;
- a deleted fact is gone everywhere, with no Undo on a screen (D-11);
- values live only in the memory tables (D-13).

## Decision
1. **`/v1/memory`** (`apps/api/src/memory`) over the existing core services:
   - `GET facts`: active facts, filtered by `subjectType`, `clientId` (the client's facts and their visit notes), `bookingId` (one visit) or `sensitive`;
   - `POST facts`: added on a screen, so it works while learning is paused;
   - `PATCH facts/:id`, `DELETE facts/:id` (final);
   - `POST facts/shown`: the chip's live read, by id;
   - `GET episodes`, `DELETE episodes/:id`: the member's own past conversations;
   - `GET settings` (everyone), `PUT settings` (`settings.manage`): the pause switch.

   Who may read or change a fact stays the service's and RLS's call. A fact the member can't read is not found. One they can read but not change is `forbidden`.

   Answers are parsed against the contracts on the way out, and each is sent `Cache-Control: private, no-store`. The service worker never caches `/v1` (ADR-0023), so a deleted value can't linger in a cache.

   New error codes:
   - `memory_fact_not_found`;
   - `memory_subject_not_found`;
   - `memory_episode_not_found`;
   - `memory_limit_reached`;
   - `memory_paused`.
2. **A screen's view of a fact** (`MemoryFactViewSchema`) adds what a screen needs and nothing more:
   - whom the fact is about, by name (`subjectName`);
   - for a visit note, its visit (start and service name);
   - `byYou`, for the source line ("You told me in chat · Oct 12").

   The repository (`listMemoryFactsWithNames`) joins clients, staff, services and bookings inside the member's transaction. A name the member may not read stays `null`, and a db test proves the named list reaches no further than the plain one, or across businesses.

   A page lists at most 500 facts. Filters narrow it.
3. **The facts an answer used** travel by id on `message.completed` and on assistant history items (`factIds`):
   - `factIds` is optional, defaulting to none, so older events and history still parse;
   - the loop sends the facts this turn's tool answers recalled (live) before the answer;
   - history and expired turns re-derive the ids with `answerFacts` from the turn's stored tool answers.

   `MemoryFactIdSchema` and the `$fact` reader (`memoryFactRefsIn`) move to `contracts/memory-ids.ts`, so `chat.ts` can name fact ids without an import cycle. The ai package's `factIdsIn` is now that same reader.
4. **The Remembered chip** (`@pepper/ui` `Remembered`, a client component) sits under an answer whose `factIds` are not empty:
   - opening it reads the facts live, so a forgotten one shows as no longer remembered;
   - each fact has Fix in place, and Forget after one confirm that says it can't be undone.

   *Why?* keeps listing the memory used (AC-W7-1).
5. **"What I know"** (`/memory`, reached from the chat header next to Autonomy; the bottom bar has no room for a seventh tab):
   - facts are grouped: learned rules apart (keys `rule_*`, linked to the rules or team screen), then clients with their visit notes, team, services, business;
   - filters: clients, team, services, business, sensitive;
   - each fact shows its source and date;
   - Edit and a final Delete appear where the role may change the fact (the api decides);
   - the member's own past conversations, which they can delete;
   - the pause switch: owners and managers change it; others see its state.

   The prototype's view is the mock-up. Its Undo after a delete is dropped for D-11.
6. **The client profile** shows:
   - "What Pepper knows", with add by hand, edit and delete;
   - "Visit notes", with edit and delete.

   **The booking sheet** reads a visit's notes fresh when it opens, and adds, edits and deletes them. A fact added by hand names what it is about ("Allergy", "Formula") and the note. Health and personal keys stay sensitive by default (ADR-0034).
7. **`remember_fact`'s guide is narrowed:**
   - "closed days and hours" are now the business's own;
   - a staff member being off, away or busy, said without "note" or "remember", is `block_time` ("Marco is off on Friday"; S31's drift of `tool-block-time-2`).

   The scripted cassettes pass. The recorded real-model cassettes go stale on every case, because the tool catalog is in every request. S32b re-records them.

## Results (S32b, 2026-10-23, recorded on `gpt-6-luna` low / `gpt-6.1-sol` low)
Probe of the sets the guide touched ($0.1116), then all 192 cases at pass^1 ($0.1079); Phase 7 total $0.8994 of $1.00. Replayed free: every gate met.

| Set | Passed | Gate |
|---|---|---|
| scheduling | 41/42 (98%) | 90% |
| ambiguity | 11/12 (92%) | 90% |
| failure · follow_through | 8/8 · 15/15 | 90% |
| permissions · autonomy · safety | 9/9 · 10/10 · 19/19 | 100% |
| memory_write | 15/15 (0 invented facts) | 90% |
| memory_recall | 17/17 | 95% |
| memory_delete · memory_safety | 12/12 · 14/14 | 100% |
| episodic | 9/9 | 95% |
| learned_rules | 10/10 (0 rules applied without an OK) | 90% |
| episode_retrieval recall@5 | 25/25 | 95% |

- `tool-block-time-2` ("Marco is off on Friday") now goes to `block_time`, and `mr-same-as-last-time` books Maria with Jess: `KNOWN_REAL_MODEL_MISSES` is empty.
- One case grader corrected where the model was right: `just-do-it-still-asks` matched "has been cancelled" inside "Nothing has been cancelled yet" (the model had only proposed it). The pattern now skips the phrase after "nothing" and still catches a claimed cancellation.
- Misses left, both held out (measured again at S33): `in-two-days` (no `find_availability` call) and `who-works-saturdays` (read Saturday's diary, not the team list).

## Consequences
- Members can see, correct and delete what Pepper remembers without the chat. Staff see exactly what RLS allows.
- `message.completed` is larger by at most 100 ids. Ids only: values stay in the memory tables.
- The real-model replay test failed on the S32a branch until S32b recorded (above). S32a ended with its branch pushed and no PR (the M2 split).
- Not done here:
  - adding business, team or service facts by hand (the chat does it; a screen for it can follow when asked for);
  - changing a fact's sensitivity on a screen;
  - the AC-W3-2 warning end to end in Playwright, which needs a template picked at onboarding (Phase 9).
