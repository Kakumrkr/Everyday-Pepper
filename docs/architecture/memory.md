# Persistent Memory

> Provides: facts, episodic recall, learned rules · Depends on: db (pgvector), AI adapter (embeddings), core entities · Consumed by: AI agent, operator feed, "What I know" page

## Types
1. **Structured facts** — `(subject_type, subject_id, key, value, sensitivity, source, created_by, status)`. Subjects: business, staff, customer, service, and booking (**visit notes**: "Oct 12: 6N + 20 vol"; PCR-005). One current value per subject + key; the previous value is kept only for the 7-day Undo window, in the same row. Examples: "Maria — allergy — PPD (sensitive)", "business — prefers — no bookings before 10 on Mondays".
2. **Learned rules** — preferences that change behaviour. Proposed by the AI from conversation through the dial action `rule.change` (always "ask"), **become enforced rules only after an owner or manager confirms**, then live in the rules engine (existing rule types or working hours, deterministic), linked back to the originating fact.
3. **Episodic memory** — a short summary per conversation (own-only, like conversations; kept 365 days), embedded (pgvector) for semantic recall.

## Write policy
- Save only explicit statements or confirmed inferences; never invent facts. Anything from untrusted text (booking-page messages, imports) arrives as a proposal.
- The AI saves through `remember_fact` and `add_visit_note` under the dial action `client_note.save` (S30, ADR-0035). The value is stored first as a `proposed` fact, so the trust layer's proposal and receipt hold only its id. The dial then runs it or asks; after text from outside the team it always asks. Undo forgets a new fact everywhere or brings back the replaced value. `forget_fact` always asks.
- Owners can pause remembering for the business; existing memory still helps and can still be deleted.
- Sensitive categories (health/allergy, personal circumstances) tagged; shown only to roles permitted to see customer notes.
- Every fact records its source message/action for explanation and audit.

## Recall policy
1. Deterministic: facts attached to the entities a tool returns (client, staff member, service, booking with its latest visit note) plus a business-facts block in the context. Recalled memory is labelled untrusted every time. Stored tool answers name facts by id (`{ "$fact": id }`), filled in for each request as the member, so a forgotten fact never reaches the model again and a changed one is current (S30). A booking for a service the template warns about carries the client's matching facts as warnings on its card (`TemplateSchema.memory.warnings`).
2. Semantic, on demand (PCR-005): the `search_memory` tool returns the member's own top-5 episodes by exact similarity search inside the tenant and member (HNSW later, past ~20k episodes a business).
3. Token budget per turn (≤ 600 tokens); facts beat episodes when trimming.

## User control
"What I know" page: list/filter, edit, delete, see source. **Forget everywhere** (PCR-005): values live only in the memory tables; trust records and stored tool answers refer to them by id. One delete removes the fact, its previous value, its embedding and the episodes that name it, and scrubs the stored conversation text that quoted it, in one transaction. In a conversation whose tool answers named the fact, every AI answer from that look-up on is replaced too, since a model may reword what it read (ADR-0036); the deletion eval verifies the value never reaches the provider again, including in the same conversation continued. Included in tenant data export and account deletion.
