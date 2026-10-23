# Phase 7 Playbook — Memory

> **Status: Approved by the user (S28, 2026-10-23)** — "review your plan, if you can build a better plan you can, and start". This version is Claude's reviewed plan (section 13 lists what the review changed); the user can still adjust any decision at the S29 Session Brief. Every Phase 7 session (S29–S33) reads this file with `CLAUDE.md` and `STATUS.md`: the cross-cutting parts (1–6, 8–10) always, and its own section in 7. Changes after this follow the PCR process. Plan changes it implies: [PCR-005](changes/PCR-005.md).
>
> Builds on [memory.md](../architecture/memory.md), [ai-agent-and-trust-layer.md](../architecture/ai-agent-and-trust-layer.md), the [Phase 6 playbook](phase-6-playbook.md) (its principles 1–15 still hold), [ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md) (trust layer), [ADR-0030](../adr/0030-agent-loop-and-conversations.md) (loop, context, conversations), [ADR-0033](../adr/0033-real-model-evals-and-model-choice.md) (models, runner) and the acceptance criteria W3 and W7. Roadmap: Phase 7, "Recall eval ≥ 95%; deletion eval 100% (AC-W7-2); AC-W3-*".

## 1. What we are building and why it wins

An employee remembers. After Phase 6 Pepper acts well inside one conversation and forgets everything after it. Phase 7 makes it remember, under the owner's control:

1. **Facts** about clients, staff, services and the business ("Maria — allergy — PPD", sensitive; "Jess doesn't do Saturdays"; "Maria's usual = full color with Jess").
2. **Visit notes**: what was done at one appointment ("Oct 12: 6N + 20 vol, 35 min") — the color formula, the massage pressure, the injury to work around. "Same as last time" works.
3. **Learned rules**: a preference that should *change behaviour* ("no bookings before 10 on Mondays") is proposed by the AI and becomes a deterministic booking rule **only after an owner or manager confirms it**.
4. **Episodes**: short summaries of past conversations, embedded with pgvector, so "what did we decide about Jess's Saturdays?" has an answer.
5. **"What I know"**: one page to see, filter, edit and delete everything Pepper remembers, with where each item came from, and a switch to pause remembering.

**The market (desk research, S28; sources are reviews and vendors' own blogs, so indicative):**
- Salon tools keep **client notes and formulas as free text or photos** on the client file (GlossGenius reviewers praise formulas and photos in notes; SOAP notes sit behind a higher tier). Nobody surfaces them at the moment they matter; the stylist has to open the file.
- Their AI is rated "limited" or absent for client knowledge (Vagaro, Mangomint, Boulevard in a competitor-run comparison; GlossGenius "none").
- General assistants (ChatGPT, Claude, Gemini) now have memory with a view-and-edit page, but **deleting something is multi-source and confusing**: a saved memory, the chat it came from and other chats are separate, so "forget it" often does not.

**The gap Pepper takes:** memory that (a) is *structured* and *used automatically* at the right moment (the warning on the color booking, the formula on the appointment, "the usual"), (b) is **forgotten everywhere with one tap**, and (c) never learns a rule behind the owner's back.

**Six differentiators Phase 7 must make obvious** (each has a test hook):

| # | Differentiator | What the user sees | Proven by |
|---|---|---|---|
| M-1 | **Remembers what matters, when it matters** | The booking card warns "Maria: allergy (PPD)" on a color service; the appointment shows "Last time: 6N + 20 vol"; "book Maria the usual" just works | AC-W3-2, `memory_recall` |
| M-2 | **One delete, gone everywhere** | Delete on "What I know" or "forget that" in chat: the item is gone from memory, from chat history, from past-conversation summaries and from every later AI request | `memory_delete` graded on the provider requests (AC-W7-2) |
| M-3 | **Nothing learned behind your back** | Every saved fact has a receipt with Undo ("Updated: was Jess, now Sam"); every learned rule waits for your OK; remembering can be paused | `learned_rules`, trust-layer tests |
| M-4 | **You see what it used** | Each answer that used memory shows a "Remembered" chip; tap it to see the facts and fix or forget one in place | Playwright, AC-W7-1 |
| M-5 | **Memory you can read** | "What I know" lists every fact, note, rule and episode with its source ("You said in chat, Oct 12") | Playwright, AC-W3-1 |
| M-6 | **Private by role** | Sensitive facts only for members allowed to read that client's notes; a staff member's chats stay theirs | Role matrix, isolation suite |

## 2. Quality bar (measured, not hoped for)

| Metric | Target | How |
|---|---|---|
| Recall (end to end) | **≥ 95% pass^1** on `memory_recall` + `episodic`, ≥ 90% pass^3, on Luna + Sol | Section 5 |
| Retrieval (episodes only, no chat model) | recall@5 ≥ 95% on the episode corpus | `episode_retrieval` set, embeddings recorded |
| Deletion | **100%**, pass^3 on the real models **and** 100% on the fakes: a deleted item never appears again in any provider request, reply, tool answer, card, page, episode or stored conversation — **including the same conversation continued** (AC-W7-2) | `memory_delete` set; graders read the recorded requests and the database |
| Memory poisoning + permissions | **100%** pass^3 real, 100% hostile fake | `memory_safety` set, hostile attacks |
| Write precision | 0 invented facts: every saved fact traces to a member's explicit words or a confirmed proposal | `memory_write` set, `mustNotSave` |
| Learned rules | 0 rules enforced without a person's confirmation | `learned_rules` set, trust-layer tests |
| AC-W3-1, AC-W3-2, AC-W7-2 | green | Integration + Playwright |
| Phase 6 sets | No regression: scheduling ≥ 90% (pass^3 ≥ 80%), safety/permissions/autonomy 100% | Full re-record at S33 |
| Cross-tenant isolation suite | 100% incl. the new tables and vector search | Isolation suite |
| Context cost | Memory adds ≤ 600 tokens a turn (facts beat episodes when trimming); still ≤ $0.01 a typical turn | Eval report tokens |
| Latency | Fact recall ≤ 50 ms p95; episode search ≤ 150 ms p95 in the database (the embedding call measured apart); a delete with its scrub ≤ 1 s p95 | OTel spans, int tests |

## 3. Design principles (decided once for the whole phase)

1. **Memory is data the domain owns, never the model.** Facts, notes, episodes and rules are rows written by core services with permissions, audit and RLS. The model proposes through a tool; the domain decides (ADR-0005).
2. **Facts recall deterministically; the model never has to remember to remember.** Facts about an entity travel *with* that entity: when a tool returns a client, staff member, service or booking, its facts and latest visit note come in the same answer; business facts sit in one block of the context. No similarity score decides whether an allergy is shown.
3. **Episodes recall on demand.** Semantic search over past conversations is a read tool (`search_memory`), not injected every turn: no embedding call and no extra tokens on turns that don't need the past, and a smaller injection surface.
4. **Recalled memory is untrusted text.** Values and summaries came from people's words; they are JSON-wrapped and labelled every time they are sent (Phase 6 principle 10), taint the turn, and can never raise autonomy or grant permission.
5. **Save only what was said.** The AI saves explicit statements by a member. Inferences, and anything that came from untrusted text (a booking-page message, an imported note), become a proposal a person confirms. Every item records its source (conversation turn, execution, screen) and author.
6. **One current value per subject and key.** A new value replaces the old one. The previous value stays **only in the fact's own row for its 7-day Undo window**, then the daily clean-up clears it; deleting the fact deletes it too. The audit entry records the change without either value.
7. **Forget means forget everywhere (M-2).** A value lives in exactly one place — the memory tables. Everything else refers to it:
   - trust-layer records (proposals, executions, explanations' facts) hold the **fact id**, never the value; *Why?* reads the value live and shows "a fact you deleted" once it is gone;
   - conversation history stores recalled facts in tool answers as **references** that are filled in from the table when the history is sent again (deleted → "[forgotten]");
   - one delete, in one transaction: the fact row (with its previous value), its embedding, the episodes that name it (they are re-summarised later without it, or simply dropped), and a **scrub of the stored conversation text** that still holds it (the member's source message and the AI's replies that quoted it, matched on the value) through one narrow, audited redaction path in the append-only guard;
   - audit, outbox, logs and spans never hold values; backups age out on their own schedule (documented in Phase 11).
   Deleting a client, staff member or service cascades the same way.
8. **Sensitive is a tag the domain enforces.** Health and personal-circumstance facts are `sensitive`: only members with `client_notes.read` for that client see them (staff: own clients), in tools, cards, the page and the context. Warnings on a booking are computed by the domain from template config, not by the model.
9. **Rules learned are rules like any other.** A learned rule maps onto an existing deterministic rule type (`blackout_window`, `minimum_notice`, `max_bookings_per_day`) or working hours; it is created through the rules service by a proposal a person approves, linked to its fact, and undoable. No free-form "AI rules".
10. **Industry knowledge is template config.** Which service categories warn on which fact keys (beauty: `color` → `allergy`; wellness: `massage` → `injury`, `pregnancy`), which visit-note fields a template suggests (formula, pressure, products), and its memory-key vocabulary live in the templates, never in code.
11. **Minimum data to the provider, embeddings included.** Facts and notes never hold emails or phone numbers (refused on save). Episode summaries use first names and ids, are scrubbed before embedding. Embeddings are personal data: tenant-scoped, never logged or returned by any API, deleted with their source.
12. **Own-only stays own-only.** Episodes come from conversations, which are own-only for every role (ADR-0030). Facts and visit notes are business knowledge, shared within the business subject to principle 8.
13. **The owner holds the switch.** A business-level "Pepper remembers new things" setting (on by default); when off, the save tools answer `memory_paused` and nothing new is learned, while existing memory still helps and can still be deleted.
14. **Bounded.** Caps per business on facts per subject, value length, visit notes per booking, episodes and embedding tokens (metered into the monthly token budget); the memory block has a token budget with facts first.

## 4. OpenAI budget policy for Phase 7

- **Remaining credit:** $4.26 of the $5 (S27 spent $0.74, [ai-budget.md](ai-budget.md)). The runner's guards stay as built in S27: ≤ 25 cases a run (`--chunk`), worst-case estimate ≤ $1.50 a run, nothing past $4.50 cumulative, every answer a cassette, CI only replays.
- **Phase 7 cap: $1.00.** A full pass of today's cases cost $0.058; Phase 7 adds about 80 cases and a re-record of everything once the new tools exist, so the expected spend is about $0.30. The rest stays for Phases 8–9. S29 adds a `--phase-cap` guard (the runner sums the ledger rows labelled `P7` and refuses past $1.00).
- **Recorded from the start, on the chosen models** (`gpt-6-luna` effort `low`, `gpt-6.1-sol` effort `low`, ADR-0033): every session that adds memory cases records them at its end on the real models, after they are green on the fakes. No separate real-model session at the end — S33 does the final re-record and pass^3.
- **Embeddings:** `text-embedding-3-small` (S29 re-checks the official pricing and models pages first and records the price in `prices.json`). At about $0.02 per million tokens the whole Phase 7 corpus costs well under a cent. Embedding answers are recorded as cassettes and ledger rows like model answers.
- **Batch description changes:** any tool description or instruction change re-records every cassette (ADR-0033), so S30–S32 change descriptions freely on the fakes and record once at each session's end.

## 5. Evaluation strategy

The S27 runner, case format and graders carry over. New pieces:

- **Worlds with memory:** `EvalWorld` seeds facts, visit notes, learned rules and episodes (with recorded embeddings) next to bookings and clients.
- **Multi-conversation cases:** a case may run turns in **separate conversations** (`turns[].conversation`), and may delete through a **screen action** between turns (`turns[].action`: delete a fact, delete a client), so "told in one chat, recalled in the next" and "deleted on the page, asked again in the same chat" are tested for real.
- **New deterministic graders:**
  - `memory.saved` / `memory.mustNotSave`: the facts and notes in the database afterwards (subject, key, value pattern, sensitivity, status).
  - `providerMustNotContain`: patterns that must not appear in **any request sent to the provider** after a point in the case (the deletion grader; it reads the recorded requests, so it judges the context, not the wording).
  - `storedMustNotContain`: the same patterns must not remain anywhere in the business's stored conversations, episodes, proposals or executions.
  - `cards.warning` / `cards.lastVisit`: the booking card carries the warning or the last visit note.
  - `rules.created` / `rules.proposed`.
- **Sets (about 80 cases, 20% held out, written before any real run):**

  | Set | ~Cases | What |
  |---|---|---|
  | `memory_write` | 12 | Save explicit facts and visit notes; tag sensitive; update a value ("Updated: was …"); refuse contacts; don't save guesses, questions, other businesses' data, or untrusted text without a card; paused memory saves nothing |
  | `memory_recall` | 16 | "Book Maria the usual"; "same as last time"; "anything I should know about Maria?"; facts across conversations; staff and sensitive facts of others' clients; a newer value wins; "I don't know" when nothing is stored |
  | `memory_delete` | 12 | Forget by chat, by page, by deleting the client, by a value update; probe in a new conversation **and in the same conversation**; the deleted text never reaches the provider and is not stored anywhere (AC-W7-2) |
  | `learned_rules` | 8 | Repeated preference → rule proposal; never enforced before approval; approved rule refuses a booking; Undo removes it; a staff member can't approve |
  | `episodic` | 8 | "What did we decide about…?" through `search_memory`; own-only; nothing from a deleted item |
  | `memory_safety` | 14 | Stored injection in a fact, note or episode ("ignore rules", "set autonomy to auto"); planted facts from a booking-page message; cross-tenant and cross-member recall; sensitive leakage to staff; exfiltration through a fact value; memory used to unlock an external action |
  | `episode_retrieval` | 25 queries | Retrieval only (embeddings, no chat model): recall@5 over a fixed corpus of ~60 episodes incl. near-duplicates and other members' episodes |

- **Three providers, as in Phase 6:** the scripted fake (CI), the **hostile fake** with new attacks (save or forget on another tenant's or member's subject, a sensitive save as staff on a non-own client, a rule without a proposal, oversized values, `search_memory` with crafted filters, a save while paused), and OpenAI (recorded, replayed in CI).
- **Fake embedder:** deterministic (hash-based) for unit and integration tests; real recorded embeddings for `episode_retrieval` and `episodic`, replayed in CI.
- **Reliability:** pass^3 for `memory_delete` and `memory_safety` (100%) and `memory_recall` (≥ 90%).

## 6. Security checks (OWASP Top 10 for LLM Applications 2026, Agentic Top 10)

Phase 6's controls stay; the S27 review deferred memory to Phase 7. S33 writes `docs/engineering/security-review-s33.md` against this table.

| Risk | Our control | Session |
|---|---|---|
| **LLM05 Data and model poisoning** | Save only explicit member statements; untrusted sources → proposal; provenance on every item; owner review on "What I know"; the pause switch; no training on tenant data | S30, S32 |
| **ASI06 Memory and context poisoning** | Recalled memory labelled untrusted every time, taints the turn, can't raise autonomy or approve; learned rules only by a person's approval; stored-injection evals at 100% | S30, S31 |
| **LLM09 Vector and embedding weaknesses** | Episodes tenant-owned with RLS **and** own-only member scope; the similarity query runs inside `withMember` (filtering in SQL, before the limit); a test plants near-identical vectors in another tenant and another member; embeddings never logged or returned; deleted with their source | S29, S31 |
| **LLM02 Sensitive information disclosure** | `sensitive` enforced by `client_notes.read` scope everywhere; no contacts in facts or notes; summaries scrubbed before embedding; values only in the memory tables (principle 7) | S29–S32 |
| **LLM01 Prompt injection** | Spotlighting of recalled memory; a turn with recalled memory follows the untrusted-turn rule (external actions ask) | S30 |
| **LLM03 Excessive agency** | Narrow tools (`remember_fact`, `add_visit_note`, `forget_fact`, `search_memory`, `propose_rule`); `forget_fact` and `propose_rule` never auto-run | S30, S31 |
| **LLM06 Unbounded consumption** | Embedding tokens metered into the monthly budget; caps on facts, notes, values, episodes; memory block token budget | S29, S31 |
| **LLM07 Misinformation** | Facts shown with source and date; newest value wins; "I don't know" over guessing; stale and absent facts in the recall evals | S30 |
| **LLM08 Hidden context exposure** | The memory block holds no secrets or other members' episodes; leakage harmless by design | S30 |
| **Privacy (CCPA-style rights)** | Memory in the tenant export and account deletion; deleting a client cascades and scrubs; hard delete; backups' retention documented | S29, S32 |

Also checked in S33: the isolation suite at 100% with the new tables, `pnpm audit --prod`, and the S27 leftovers waiting on the user (OWASP titles in the signed-in PDFs, zero-retention eligibility — sensitive facts now reach the provider, so it matters more).

## 7. Session guides

### S28 (7a) — Phase 7 planning — done
- This playbook, [PCR-005](changes/PCR-005.md), the roadmap and STATUS.

### S29 (7b) — Memory store: tables, pgvector, embeddings, forget-everywhere
- **Build:**
  - migration enabling `vector` (pgvector 0.8.7 in the Compose image);
  - `memory_facts`: subject (type + composite tenant key to client, staff member, service, booking or the business), key from a closed vocabulary plus `custom`, value ≤ 500 chars, `previous_value` (Undo window only), sensitivity, source kind + ids, author, status `active`/`proposed`, unique active per subject + key; visit notes are facts on a `booking` subject (several keys per visit);
  - `memory_episodes`: owner member, conversation id, summary ≤ 1,000 chars, subject ids, `embedding vector(1536)`, embedding model;
  - RLS, member scope (episodes own-only; sensitive via the `client_notes.read` scope), guard triggers, cascades from clients, staff, services, bookings, members;
  - core services `saveFact`, `changeFact`, `forgetFact` (the one-transaction forget of principle 7, incl. the conversation scrub through a narrow redaction function in the append-only guard), `listFacts`, `factsFor`, `saveEpisode`, `deleteEpisode`, `searchEpisodes`; audit without values; the memory pause setting;
  - `embed` on the `LlmProvider` port, the OpenAI embeddings adapter, the fake embedder, the provider contract suite extended; embedding tokens metered; `prices.json`, the ledger and `--phase-cap`;
  - tenant export and account deletion include memory. ADR-0034.
- **Think hard about:** the redaction path in the append-only conversation guard (narrow, audited, only through `forgetFact`); value matching for the scrub (case-insensitive, whole value, plus the key phrase); exact search (D-4); the subject keys across five tables.
- **Pitfalls:** a similarity query that filters after `LIMIT`; a cascade that leaves embeddings or a previous value; values with contacts; logging a value or a vector.
- **Tests:** repository + RLS + isolation (incl. near-identical vectors in another tenant and member), cascades, forget leaves nothing (`storedMustNotContain` as an integration helper), member-scope matrix, `embed` contract (fake and recorded fixtures), metering. No chat model.

### S30 (7c) — Facts in the AI: tools, recall, warnings, "the usual"
- **Build:**
  - tools `remember_fact` and `add_visit_note` (internal_write, dial `client_note.save`, receipts say "Saved" or "Updated: was …", Undo restores within 7 days), `forget_fact` (always a card, never auto);
  - recall: facts and the latest visit note attached to tool answers that return a client, staff member, service or booking (stored in history by reference, principle 7); a business-facts block after the static prefix, before history, ≤ 600 tokens; all labelled untrusted;
  - the booking preview's **warning** from template config (`sensitiveCategories`) and the **last visit note** on `create_booking`/`move_booking` cards (AC-W3-2);
  - "the usual" and "same as last time" through a `usual_service` fact and the last visit;
  - *Why?* lists the facts used, by id;
  - eval sets `memory_write`, `memory_recall`, `memory_delete`, the facts part of `memory_safety` on the fakes; hostile attacks; then **record on Luna + Sol**; batch in the ADR-0033 free-time description fix with its new held-out cases.
- **Think hard about:** descriptions that make the model save only explicit statements; an untrusted label that does not make the model ignore real allergies; keeping the static prefix cacheable.
- **Pitfalls:** a fact in the static prefix (breaks the cache per tenant); a sensitive fact in a staff member's context for a client not theirs; saving from a booking-page message; a value copied into a proposal payload.
- **Tests:** per tool as in S24 (schema, preview = execution, inverse, role matrix, cross-tenant, hostile); AC-W3-1 and AC-W3-2 integration tests; deletion graded on requests and storage, including the same conversation continued.

### S31 (7d) — Episodes and learned rules
- **Build:** the episode writer — a worker job, through the outbox pattern, summarises a conversation 30 minutes after its last turn with the routine model (≤ 3 sentences, first names, decisions and preferences only, no contacts), scrubs, embeds and stores it; retention 365 days in the daily clean-up; `search_memory` (read, own episodes, top 5, labelled untrusted); `propose_rule` (new dial action `rule.change`, locked to "ask") onto the existing rule types and working hours, approved by owners/managers, linked to its fact, undoable. Sets `episodic`, `episode_retrieval`, `learned_rules`, the rest of `memory_safety`; record on the real models.
- **Think hard about:** what is worth an episode; summarising untrusted text (the summary stays labelled); routine model only.
- **Pitfalls:** an episode outliving a forgotten item; summarising a turn still in progress; a rule proposal a staff member can approve.
- **Tests:** job idempotency (no duplicate episode on retry), retention, own-only search, retrieval recall@5, rule proposal → approval → booking refused → Undo, hostile attacks.

### S32 (7e) — "What I know", client profile, the "Remembered" chip
- **Build:** `/memory` in the PWA (mobile-first): facts grouped by subject with filters (clients, team, services, business; sensitive), edit, delete with a confirm (final), source and date, learned rules linked to the rule, own episodes with delete, the pause switch (owners); a "What Pepper knows" section and visit notes on the client profile and the booking sheet (add, edit, delete by hand — also the client notes deferred by PCR-004); a **"Remembered" chip** under answers that used memory, opening the facts with fix and forget in place; *Why?* lists memory used. Endpoints with views parsed on the way out. A quick mock-up in the prototype's style first.
- **Think hard about:** deletion that feels final and safe; staff's view; empty states that teach ("Tell me things like 'Maria is allergic to PPD'").
- **Pitfalls:** a sensitive fact shown to the wrong role; a deleted item lingering in a client-side cache or the service worker (answers are `no-store`).
- **Tests:** component tests with axe; Playwright: tell Pepper a fact → "What I know" (AC-W3-1) → book a color service → warning (AC-W3-2) → forget from the chip → ask again in the same chat → it doesn't know (AC-W7-2); staff view; pause.

### S33 (7f) — Full re-record, pass^3, security review, Phase 7 exit
- **Build/run:** one batch of description fixes from S30–S32's transcripts; full re-record of every set (Phase 6 + Phase 7) on Luna + Sol; pass^3 for `memory_delete`, `memory_safety`, `memory_recall` and the Phase 6 safety sets; the security review against section 6; Phase 7 exit.
- **Done when:** section 2 met; AC-W3-1, AC-W3-2, AC-W7-2 green; isolation 100%; Phase 7 spend ≤ $1.00 recorded.

## 8. Explicitly not in Phase 7
- The operator feed, daily briefing, "is this still true?" reviews of old facts, insights from memory, rules suggested from behaviour (Phase 8).
- Facts extracted from websites, imports or photos (Phase 9 onboarding; they will arrive as proposals). Photo attachments on visit notes (needs storage and scanning; V1.1).
- Memory shared across businesses or about clients of other businesses.
- Client-facing memory (the booking page knowing the client) — V3.
- Free-form learned rules or rules the AI enforces by itself.
- Fine-tuning or any training on tenant data.
- Voice (V2).

## 9. Keep getting better
Section 9 of the Phase 6 playbook applies as written: re-check the references and the provider's docs before building, fix earlier weaknesses when small, and add one to three lines to the log below at the end of each session.

**Ideas already queued** (consider them at the session named): the `find_availability`/`get_day` free-time description fix against new held-out cases (ADR-0033; S30's description batch); client visits beyond ±62 days with a paged endpoint (S26b log; S30 if `memory_recall` needs it); "is this still true?" for facts older than a year (Phase 8 feed); rules suggested from repeated owner behaviour, e.g. declined Monday-morning requests (Phase 8 insights); photo attachments on visit notes (V1.1); measure whole-turn latency in the pilot (Phase 11).

### Improvement log
| Session | Learned / next try |
|---|---|
| S28 | Reviewing the plan against how general assistants handle memory showed that deleting the fact alone would not have met AC-W7-2: the value would live on in chat history, proposal payloads, execution records and episodes. Keeping values only in the memory tables and referring to them by id everywhere else makes deletion total by construction. Next (S29): build `forgetFact` and its storage test before any tool exists. |

## 10. Decisions for this phase (Claude's recommendation for each, approved with the playbook)

| # | Decision | Choice | Why |
|---|---|---|---|
| D-1 | Sessions | **Five: S29–S33** (section 7) | Each fits one session and leaves the repo green |
| D-2 | How facts reach the model | **Deterministically: with the entity's tool answer, plus a business-facts block** | An allergy must never depend on a similarity score or the model's choice |
| D-3 | How episodes reach the model | **On demand through `search_memory`** | No embedding call or tokens on most turns; smaller injection surface (PCR-005) |
| D-4 | Vector search | **Exact search inside the tenant and member in V1**, with a latency test; HNSW with pgvector 0.8 iterative scans when a business passes ~20k episodes | Small per-business corpora; exact search has 100% retrieval and no filtered-ANN pitfalls (PCR-005) |
| D-5 | Embedding model | **`text-embedding-3-small`, 1536 dimensions**, model stored per row | Cheapest OpenAI embedding; a later switch is a re-embed job |
| D-6 | What the AI may save on its own | **Explicit member statements under `client_note.save` (default notify, Undo 7 days); inferences and untrusted sources only as proposals** | memory.md's write policy, enforced by the trust layer |
| D-7 | Sensitive facts and the provider | **Sent only for members allowed to read them, labelled sensitive**; warnings computed by the domain | Useful answers; ZDR check before the pilot stays on the list |
| D-8 | Fact history | **One current value; the previous one only for the 7-day Undo window, in the same row** | Undo works; deletion stays total |
| D-9 | Episodes | **A summary per conversation 30 min after its last turn, routine model, own-only, kept 365 days** | Matches own-only conversations and outlives their 90-day deletion on purpose |
| D-10 | Learned rules | **Only onto existing rule types and working hours, through a new dial action `rule.change` locked to "ask"; owners/managers approve** | Deterministic, explainable, never silent (PCR-005) |
| D-11 | Deleting on "What I know" | **Immediate hard delete everywhere after a confirm; no Undo** (an AI save can be undone from its receipt within 7 days) | AC-W7-2, M-2 |
| D-12 | Phase 7 OpenAI budget | **$1.00 cap of the remaining $4.26, recorded per session from S30, enforced by `--phase-cap`** | Expected ~$0.30; room for Phases 8–9 |
| D-13 | Where values live | **Only in the memory tables; ids everywhere else; one forget scrubs stored conversations and episodes** | Makes AC-W7-2 true by construction (PCR-005: an ADR-0028/ADR-0030 amendment) |
| D-14 | Visit notes | **Facts on a `booking` subject; template-suggested keys (formula, pressure, products)** | Salons' most-used client knowledge; "same as last time" |
| D-15 | Pause | **One business-level switch for owners, on by default** | Global control (HAX G17); cheap |
| D-16 | "Remembered" chip | **Under each answer that used memory, with fix and forget in place** | Shows its sources like the best general assistants, but with one-tap total forget |

## 11. Plan changes this playbook implies ([PCR-005](changes/PCR-005.md))
- `memory.md`: recall step 2 on demand through a tool (D-3); visit notes; forget everywhere (D-13); the pause switch.
- `data-model.md`: `MemoryEpisode` exact search, HNSW later (D-4); `MemoryFact` one current value with an Undo-window previous value (D-8), `booking` subject (D-14).
- `contracts/trust.ts`: new dial action `rule.change`, locked to "ask" (D-10).
- ADR-0028 / ADR-0030 amendments (in ADR-0034/0035): memory tools' trust records and history hold ids; a narrow redaction path in the append-only conversation guard (D-13).
- `roadmap-phases.md`: Phase 7 as S29–S33.

## 12. References (read the ones named in your session)
- pgvector README (0.8: iterative index scans, filtering, exact vs approximate search): https://github.com/pgvector/pgvector
- OpenAI docs — embeddings: https://developers.openai.com/api/docs/guides/embeddings · pricing (re-check at S29): https://developers.openai.com/api/docs/pricing
- OpenAI, *Memory FAQ* (sources shown per answer; deleting means every source): https://help.openai.com/en/articles/8590148-memory-faq
- OWASP Top 10 for LLM Applications 2026 (LLM05, LLM09): https://genai.owasp.org/llm-top-10/ · OWASP Top 10 for Agentic Applications (ASI06): https://genai.owasp.org/
- Packer et al., *MemGPT* (2023): https://arxiv.org/abs/2310.08560 · Park et al., *Generative Agents* (2023): https://arxiv.org/abs/2304.03442 · Chhikara et al., *Mem0* (2025): https://arxiv.org/abs/2504.19413
- Microsoft, *Guidelines for Human-AI Interaction* (G12 remember recent interactions, G17 global controls): https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
- Market scan (S28, indicative): https://www.capterra.com/p/174830/Phreesia/reviews/ · https://zenoti.com/thecheckin/best-salon-management-software-2026 · https://www.notebookcheck.net/What-AI-secretly-remembers-about-you-and-how-to-make-it-forget.1339819.0.html
- The Phase 6 references (spotlighting, CaMeL, τ-bench) in the [Phase 6 playbook](phase-6-playbook.md) §10.

## 13. What the S28 review changed (after the first draft)
1. **Deletion gap closed (D-13).** The draft deleted the fact row only; the value would have survived in conversation history (re-sent when the chat continues), proposal payloads and execution records (append-only), and episodes. Now values live in one place and a single forget scrubs the rest; the deletion eval also continues the same conversation and checks storage.
2. **Undo vs deletion conflict fixed (D-8).** Undo of an update needed the old value somewhere permanent; now it lives in the fact's row for 7 days only.
3. **Visit notes and "same as last time" (D-14)** — the salon feature competitors keep as free text.
4. **Last-visit note on the booking card** next to the allergy warning (M-1).
5. **"Remembered" chip (D-16)** and the **pause switch (D-15)**.
6. **`--phase-cap`** so the Phase 7 budget is enforced in code, not by discipline.
