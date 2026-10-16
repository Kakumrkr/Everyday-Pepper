# Persistent Memory

> Provides: facts, episodic recall, learned rules · Depends on: db (pgvector), AI adapter (embeddings), core entities · Consumed by: AI agent, operator feed, "What I know" page

## Types
1. **Structured facts** — `(subject_type, subject_id, key, value, sensitivity, source, confidence, created_by, status)`. Subjects: business, staff, customer, service. Examples: "Maria — allergy — PPD (sensitive)", "business — prefers — no bookings before 10 on Mondays".
2. **Learned rules** — preferences that change behaviour. Proposed by the AI from conversation, **become enforced rules only after owner confirmation**, then live in the rules engine (deterministic), linked back to the originating fact.
3. **Episodic memory** — conversation summaries and notable events, embedded (pgvector) for semantic recall.

## Write policy
- Save only explicit statements or confirmed inferences; never invent facts.
- Sensitive categories (health/allergy, personal circumstances) tagged; shown only to roles permitted to see customer notes.
- Every fact records its source message/action for explanation and audit.

## Recall policy
1. Deterministic: facts attached to entities in scope (customer being discussed, staff, business).
2. Semantic: top-k episodic items by embedding similarity, filtered by tenant (RLS) and role.
3. Token budget per turn; facts beat episodes when trimming.

## User control
"What I know" page: list/filter, edit, delete, see source. Deletion is hard delete of fact + embedding; recall eval verifies deleted facts never reappear. Included in tenant data export and account deletion.
