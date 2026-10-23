# ADR-0035: Facts in the AI: memory tools, recall by reference, warnings and "the usual"

- **Status:** Accepted. The user approved the S30 Session Brief on 2026-10-23: "Go ahead with your recommendations, ADR is pre-approved". That covered D-1 to D-7 below. Claude made the other choices within the [Phase 7 playbook](../plan/phase-7-playbook.md) and [PCR-005](../plan/changes/PCR-005.md).
- **Date:** 2026-10-23
- **Builds on:**
  - [memory.md](../architecture/memory.md) and ADR-0034 (the store, forget everywhere);
  - ADR-0028 (trust layer), ADR-0029 (tools), ADR-0030 (loop, context), ADR-0031 (cards, *Why?*), ADR-0033 (evals, models);
  - the playbook's principles 2, 4, 5, 7, 8, 10 and 13, and §7 "S30".
- **Amends:**
  - ADR-0028: a memory save's proposal and receipt hold a fact id, never the value; an action can always ask without a dial setting;
  - ADR-0030: stored tool answers refer to facts by id, filled in for each request.

## Context
S29 built the memory tables and the one-transaction forget. S30 lets the AI use them. Three things must hold:
- the model saves only what a member said;
- facts reach the model with the record they belong to, deterministically;
- a fact's value lives only in the memory tables (playbook principle 7), so forgetting it removes it from every later request.

The last one is where a simple design fails. A save's arguments hold the value. If the trust layer stored them as the payload, every proposal, receipt and *Why?* would keep the value after a forget. The same is true of tool answers stored in the chat.

## Decision
1. **Three tools** (`packages/ai/src/tools/catalog/memory.ts`):
   - `remember_fact` (about a client, staff member, service or the business) and `add_visit_note` (one booking). Both are internal writes under the dial action `client_note.save` (default "do it and tell me", Undo 7 days).
   - `forget_fact` always asks (D-1). It is declared `external_or_irreversible` and has no Undo.
2. **The value is stashed first.** A write tool may have `stash`. Before the trust layer sees the call, `stash` saves the value as a `proposed` fact as the member (permission, RLS, pause switch and caps apply) and returns `{ factId }`. That id is the payload: proposals, receipts, explanation steps and the fingerprint never hold the value.
   - The dry run and the execution activate the proposed fact (`activateFactIn`). The subject's current fact with that key takes the new value, and the old one is kept for the Undo window. Or the proposed row becomes the current one.
   - A call that is refused, or a retry that found another's result, discards its proposed fact (`unstash`). The daily clean-up deletes proposed facts older than two days, so a proposal that expired or was turned down leaves nothing.
   - Migration 0040: deleting a **proposed** fact scrubs nothing. It was never remembered, and the words it came from are the member's own chat.
   - Undo of a new fact forgets it everywhere (ADR-0034), and Undo of a replaced one brings the old value back. Both refuse once the fact changed since (its `updatedAt`).
   - Two saves of one key at once take turns (a transaction advisory lock per subject and key). Before this, a retried call broke "one current value per key".
3. **Who the record is:** a memory save's record owner is the member who asked. The domain already limited the subject to what they reach, and staff's own-scoped permissions need an owner.
4. **Recall by reference.** A read tool's answer names facts as `{ "$fact": id }`:
   - `find_clients` names them for up to 3 matches, with the client's last noted visit (`lastVisit`: date, service, staff, notes);
   - `find_client_bookings` names the client's facts and last noted visit;
   - `get_booking` names the visit's notes and the client's, service's and staff member's facts;
   - `list_services_and_staff` names each service's and staff member's facts.

   The loop fills the references in for **every request**, as the member (RLS: a staff member never gets a fact they may not read). A gone or hidden fact is left out, up to 1,200 characters of values an answer. So a forgotten fact is gone from every later request, the same chat included, and a changed one is current. The business's own facts (at most 30, 1,200 characters) come as one block of the instructions, after the business and before the clock. The cached prefix is unchanged. All of it is JSON-wrapped and labelled untrusted.
5. **Two kinds of untrusted** (found while building). Remembered facts mark the turn untrusted (principle 4): external actions ask, and quiet writes become "done, with Undo". But only text from **outside the team** (a client's words) makes a memory save always ask (D-2, new `outsideText` on the autonomy request). Remembered facts were a member's words or a person's OK already. Treating them as outside text made every save after a lookup a card.
6. **Warnings and the last visit on booking cards** (AC-W3-2). The template config is now `TemplateSchema.memory`:
   - `warnings` per service category, e.g. beauty `Color` → `allergy`; massage `Massage` → `injury`, `pregnancy`, `health`;
   - `visitNoteKeys`, the visit-note keys the template suggests, given to the model in the template's part.

   `create_booking` and `move_booking` add the client's warned facts and last visit notes to the explanation by id (`memory_warning`, `last_visit`, `memory_last_visit`), and to the model by reference. A member who may not read the fact gets no warning (D-3). The domain computes the warnings; the model never decides them.
7. **Cards and *Why?* read live.** Explanation facts that name a memory fact carry its id and a `null` value (the contract refuses a value). The proposal and receipt views carry `memory`: the saved or forgotten fact ("was: …" while Undo is open), the warnings and the last visit. *Why?* carries `remembered`, the facts the turn's answers brought (`memory_recalled`), with a deleted one shown as "A fact you deleted".
8. **"The usual" and "same as last time"** need no code of their own. The instructions say "the usual" is the `usual_service` fact and "same as last time" is `lastVisit`. The memory eval sets judge it. `AGENT_PROMPT_VERSION` is now 2.
9. **Evals.** New sets `memory_write` (gate 0.9), `memory_recall` (0.95), `memory_delete` (1) and `memory_safety` (1): 49 cases, 10 held out. Each case runs on a hand-written scripted cassette in CI. The tooling adds:
   - a `juniper_memory` world: Colour in the Color category, and Maria's colour about two weeks back;
   - seeded facts named `{{fact:<name>}}`;
   - turns in a new conversation;
   - screen actions between turns: forget, change, approve, undo;
   - graders on the facts afterwards, on **the requests sent** after a turn (deletion), on everything stored, and on the cards.

   A real run takes at most 20 cases: the bigger prompt put a 25-case worst case over $1.50.
10. **D-4:** the `find_availability`, `get_day` and `create_booking` guides answer "is Jess free at 10?" from the day without asking for a service, and "find a time and book it" books the first time that fits. Three new held-out cases go with the change.

## Alternatives considered
- **Keep the value in the proposal payload and scrub trust tables on forget:** more places to scrub and to miss. The stash keeps the value in the one table that forget already covers.
- **Store filled-in tool answers and scrub them:** a staff member's stored answer would hold what an owner later restricted, and a change would not reach old answers. References are filled per request, as the member.
- **A new dial action `memory.forget` locked to "ask":** a contract change and a PCR, for what `alwaysAsks` gives without one.
- **Remembered facts count as outside text:** the safest reading of principle 4, but every update after a lookup became a card. Outside text still always asks.

## Consequences
- A memory save after a lookup of a client with facts is "done, with Undo" at the default dial. After a client's message in the turn, it waits for the OK.
- A booking that sends a client email, in a turn that read remembered facts, asks first (external action, untrusted turn). This holds even when the dial says "just do it" for confirmations.
- Every tool description and the instructions changed: all real-model cassettes go stale and are re-recorded (D-5). Until then CI's replay of the recorded model fails. The recording needs `OPENAI_API_KEY`, which this session's container lacked, so it moves to the next session.
- The e2e businesses have no template, so Playwright covers saving, updating, *Why?* and Undo of a fact. The warning is covered by component and integration tests (AC-W3-2) until onboarding picks a template (Phase 9).
- `forget_fact` approved by a lead removes the value from every member's chats (ADR-0034).
