# ADR-0034: The memory store, forget everywhere, and the embedding port

- **Status:** Accepted. The user approved the [Phase 7 playbook](../plan/phase-7-playbook.md) and [PCR-005](../plan/changes/PCR-005.md) in S28, then said at the S29 brief: "Go ahead with your recommendations, start S29". That included the recommendation to test embeddings on fixtures shaped like OpenAI's documented answers ($0) and to record real embeddings in S31. Claude made the choices below within the playbook's decisions D-1…D-16.
- **Date:** 2026-10-23
- **Builds on:**
  - [memory.md](../architecture/memory.md) and PCR-005;
  - ADR-0010 (roles, RLS), ADR-0017 (member scope), ADR-0027 (provider port, evals), ADR-0028 (trust layer), ADR-0030 (conversations), ADR-0033 (models, ledger);
  - the playbook's principles 6, 7, 8, 11, 12, 13 and 14, and §7 "S29".
- **Amends:** ADR-0030. Conversation messages stay append-only for the services, but the forget trigger (below) may now rewrite them. ADR-0027: `embed` is a port of its own, not a method on `LlmProvider`.

## Context
Phase 7 gives Pepper memory under the owner's control. S29 builds the storage only, with no tools and no prompt change:
- facts and visit notes;
- conversation summaries (episodes) with their embeddings;
- a pause switch;
- an embedding port;
- the playbook's promise that one delete forgets a value everywhere (AC-W7-2, M-2).

The hard part is the last one. A fact's value also sits in the chat it came from, in later turns that quoted it, in the AI's answers, and in episodes. Deleting the row alone leaves all of that, and the model is sent it again when a chat continues.

## Decision
1. **Tables** (migrations 0037–0039):
   - **pgvector:** `CREATE EXTENSION IF NOT EXISTS vector`. The extension is not marked trusted, so the migration role must be allowed to create it: the Compose and CI superuser, or a managed host's admin role. If neither, an administrator creates it first (Phase 11 deployment note).
   - **`memory_facts`:**
     - The subject is one of business, client, staff member, service or booking. A fact on a booking is a **visit note**. Each subject type has a composite key to its own table, cascading on delete.
     - It holds the key, the value (1–500 characters), and `previous_value` with `previous_until`: the replaced value, for the 7-day Undo window only.
     - It also holds `sensitive`, `status` (`active` or `proposed`), `source` (`screen`, `chat` or `ai_action`), the source turn (no key: conversations go after 90 days) and the author.
     - A partial unique index allows **one active value per subject and key**. Proposals may queue.
     - A guard trigger keeps the subject, key and origin fixed. A proposal may become active, never the other way.
   - **`memory_episodes`:**
     - It holds the member, the conversation (no key), a summary of up to 1,000 characters, the clients it names (up to 20), `vector(1536)` and the embedding model.
     - It is written once: `UPDATE` is revoked from the services.
     - It goes with its member (membership key) and with any client it names (trigger).
   - **`tenants.memory_paused`.**
2. **Who reaches what** (restrictive RLS, as Postgres prints it in the isolation suite):
   - **Owners, managers and work without a user:** everything.
   - **Staff can read:** facts of clients and visits they reach (the clients' and bookings' own member scope applies inside the sub-selects), their own staff member's facts, and the business's, staff's and services' **non-sensitive** facts.
   - **Staff can change** only what they reach through a subject: never business-wide facts.
   - **Episodes** are own-only for every role, like conversations.
   - Core adds the permissions on top:
     - client and visit facts: `client_notes.read` / `client_notes.manage`;
     - staff facts: `staff.manage`;
     - service facts: `services.manage`;
     - business facts: `business.update`;
     - pausing: `settings.manage`;
     - episodes: `ai.chat`.
   - A staff member who can read a fact but not change it gets `ForbiddenError` (the service reads before it locks). A fact they can't read is "not found".
3. **Forget everywhere.** A row-level `AFTER DELETE` trigger on `memory_facts` runs for every delete: by a member, by Undo (S30), or with its client, staff member, service or booking. It calls `memory_scrub` for the value and the Undo-window previous value, inside the deleting transaction:
   - **What it matches:** whole words, case-insensitive. Characters other than letters, digits and spaces are escaped; runs of spaces match any whitespace. A second pattern matches the value as it appears inside JSON text.
   - **What it changes:** every member's conversation messages (the member scope is lifted for the statement), always limited to the fact's own business. In each turn that held the value:
     - the text and tool-call arguments become "[forgotten]";
     - a card that held it is dropped (a longer text could break its shape);
     - the provider's opaque reasoning items are dropped (they may hold the value; the message phase is kept).
   - **Episodes:** those that mention the value are deleted.
   - **Only what the fact could have reached:** text written since the fact existed, plus the turn it came from. The first design scrubbed all history. The self-review found that let a staff member erase any word from the owner's older chats by saving and deleting a fact on their own client. What remains possible is bounded to the fact's lifetime and shows in the audit log (`memory_fact.created` and `.deleted` by that member).
   - **Short values:** below 3 characters ("no") the value is too ambiguous to match and goes with its row only.
   - **Not reachable directly:** the functions are `SECURITY DEFINER` with a fixed `search_path`, and `EXECUTE` is revoked from `PUBLIC`. The services can neither call `memory_scrub` nor update messages (both tested).
   - **Skipped** while the whole business is being deleted (everything goes anyway).
   - Deleting a client also deletes every member's episodes that name them.
4. **Values live only in the memory tables.** Audit entries record the subject type, key and flags, never the value or whom it is about. `memory_fact.created`/`.updated`/`.deleted`, `memory_episode.created` (actor `system`) / `.deleted`, and `memory.settings_updated` are new. S30 keeps proposals, receipts and stored tool answers to ids (PCR-005).
5. **Core services** (`packages/core/src/services/memory.ts`):
   - **`saveFact`/`saveFactIn`:**
     - It replaces the subject's active value for the key and returns the value it replaced. The old value is kept until the Undo window ends.
     - The same value again is a no-op.
     - Sensitivity defaults from the key: allergy, health, medication, pregnancy, injury, personal.
     - A subject the member can't reach is `MemorySubjectNotFoundError`. The insert runs in a savepoint, so an AI turn's transaction stays usable.
     - Caps: 50 facts per subject and 20,000 per business (`MemoryLimitError`).
     - Contacts are refused by the value schema.
   - **`changeFact`, `forgetFact`/`forgetFactIn`, `listFacts`, and `factsForIn`** (recall: a subject's active facts, sensitive first).
   - **`saveEpisode`:**
     - The episode job (S31) stores an episode for a member, as the platform.
     - It is refused while paused.
     - A member keeps at most 5,000 episodes.
   - **`listMyEpisodes`, `searchEpisodesIn`, `deleteEpisode`.**
   - **The pause switch:** `getMemorySettings`/`changeMemorySettings`. Paused refuses saves from the chat or an AI action (`MemoryPausedError`) and new episodes. A person on a screen can still save, and everything can still be deleted.
   - **The daily clean-up** clears expired Undo values and deletes episodes older than 365 days.
6. **Exact vector search** (playbook D-4):
   - `ORDER BY embedding <=> query LIMIT k` (cosine) with no index. It runs inside `withMember`, so RLS filters before the limit and every match the member may see is considered.
   - A test plants identical vectors in another business and in another member's episodes; neither is returned.
   - HNSW with pgvector 0.8's iterative scans comes when a business passes about 20k episodes.
7. **The `Embedder` port** (`packages/ai`), next to `LlmProvider` rather than on it, so the chat fakes, cassettes and recorder need no `embed` they never use:
   - **`OpenAiEmbedder`:**
     - It uses the official SDK's `embeddings.create` with floats at 1536 dimensions and no retries of its own.
     - Answers come back in input order, checked for count and size.
     - Failures map to the chat adapter's `LlmError` codes without the provider's text.
   - **`hashEmbedder`:** deterministic and free, for tests and CI. Texts sharing words are similar; it is not semantic.
   - **`meteredEmbedder`:** tokens go to the business's `llm_tokens`, like chat calls, and an answer that can't be metered is not given.
   - A shared contract suite runs on the fake and on the OpenAI adapter, with fixtures shaped like OpenAI's documented `CreateEmbeddingResponse`.
   - **Configuration:**
     - `OPENAI_MODEL_EMBEDDING` is optional; unset means memory search is off and facts still recall.
     - `text-embedding-3-small` is listed at $0.02 per million input tokens (OpenAI pricing page, 2026-10-23) in `prices.json`.
     - Nothing is wired into the api or worker yet (S31).
8. **A cap per phase for real eval runs:**
   - A recording needs `--phase` (7 or later), and its ledger label starts with `P7 `.
   - The runner refuses a run whose estimate would take the phase past its cap ($1.00 for Phase 7), and stops the next call once it is reached.
   - This is on top of the per-run cap and the $4.50 stop.

## Alternatives considered
- **Delete the fact row only:** fails AC-W7-2 as soon as a chat continues.
- **Store values in trust records and messages, and scrub every table:** more places to miss. Keeping values in one place and referring by id (S30) is safer.
- **Scrub the whole history:** stronger forgetting, but open to the erasing attack above.
- **Scrub by source turn only:** misses later turns that quoted the fact and the AI's own answers.
- **An HNSW index from the start:** filtered approximate search can return fewer than k matches under RLS. Exact search is simpler and fast at a business's size.
- **`embed` on `LlmProvider`:** every fake, the cassette provider and the recorder would need it.

## Consequences
- **Tests:** a deleted fact leaves no trace in any member's stored chats, tool calls, cards, reasoning items or episodes, and no trace in another business. Text from before the fact existed stays. Proven against real Postgres in `packages/db/src/memory.int.test.ts`, and through the services in `packages/core/src/memory.int.test.ts`.
- **What forget does not reach:** the deletion eval (S30) checks the provider requests themselves. To-do titles, booking notes and other records people typed stay as they are, edited on their own screens. Backups age out on their own schedule (documented for Phase 11).
- **Over-forgetting:** forgetting a fact whose value is a common word ("Jess") also scrubs that word from turns written while the fact existed. This is the safe direction for a user's explicit forget.
- **Performance:** each forget scans the business's messages written since the fact existed with a regular expression. That is fine at pilot size; measure it in the Phase 11 load test.
- **Limit edge case:** a message near the 100,000-character limit that grows with "[forgotten]" would fail the check and the forget with it. This is extremely unlikely; left as is.
- **Tests run with a superuser owner:** in Compose and CI the schema owner is a superuser, so the trigger runs without RLS and filters by business explicitly. With a non-superuser owner, the functions lift the member scope themselves and the tenant setting is the fact's own. The Phase 11 deployment must keep migrations on a role that owns the schema.
- **Not built yet:** there is no tenant data export or account deletion. Memory goes with its business, client, staff member, service, booking and member by keys. Export comes with the legal docs (Phase 11).
