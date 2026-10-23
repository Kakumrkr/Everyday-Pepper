# Phase 7 Playbook — Memory

> **Status: Draft for the user's approval (S28, 2026-10-23).** Once confirmed, every Phase 7 session (S29–S33) reads this file with `CLAUDE.md` and `STATUS.md`: the cross-cutting parts (1–6, 8 and 9) always, and its own section in 7. Changes after confirmation follow the PCR process.
>
> Builds on [memory.md](../architecture/memory.md), [ai-agent-and-trust-layer.md](../architecture/ai-agent-and-trust-layer.md), the [Phase 6 playbook](phase-6-playbook.md) (its principles 1–15 still hold), [ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md) (trust layer), [ADR-0030](../adr/0030-agent-loop-and-conversations.md) (loop, context, conversations), [ADR-0033](../adr/0033-real-model-evals-and-model-choice.md) (models, runner) and the acceptance criteria W3 and W7. Roadmap: Phase 7, "Recall eval ≥ 95%; deletion eval 100% (AC-W7-2); AC-W3-*".

## 1. What we are building and why it wins

An employee remembers. After Phase 6 Pepper acts well inside one conversation and forgets everything after it. Phase 7 makes it remember, under the owner's control:

1. **Facts** about clients, staff, services and the business ("Maria — allergy — PPD", sensitive; "Jess doesn't do Saturdays"; "the usual for Maria = full color").
2. **Learned rules**: a preference that should *change behaviour* ("no bookings before 10 on Mondays") is proposed by the AI and becomes a deterministic booking rule **only after an owner or manager confirms it**.
3. **Episodes**: short summaries of past conversations, embedded with pgvector, so "what did we decide about Jess's Saturdays?" has an answer.
4. **"What I know"**: one page to see, filter, edit and delete everything Pepper remembers, with where each item came from.

**Why it wins:** competitors' "ask your data" assistants answer from the booking database only; client notes are free text nobody reads at booking time. Pepper (a) *uses* what it was told at the moment it matters (the allergy warning on the color booking, AC-W3-2), (b) shows its memory and lets the owner delete any of it for good (AC-W7-2), and (c) turns repeated preferences into enforced rules without ever enforcing one silently.

**Four differentiators Phase 7 must make obvious** (each has a test hook):

| # | Differentiator | What the user sees | Proven by |
|---|---|---|---|
| M-1 | **Remembers what matters, when it matters** | The booking card warns "Maria: allergy (PPD)" on a color service; "book Maria the usual" just works | AC-W3-2 test, `memory_recall` set |
| M-2 | **Forgetting is real** | Delete on "What I know" or "forget that" in chat: the item never appears again, anywhere | `memory_delete` set graded on the provider requests (AC-W7-2) |
| M-3 | **Nothing learned behind your back** | Every saved fact has a receipt and Undo; every learned rule waits for your OK | `learned_rules` set, trust-layer tests |
| M-4 | **Memory you can read** | "What I know" lists every fact, rule and episode with its source ("You said in chat, Oct 12") | Playwright journey, AC-W3-1 |

## 2. Quality bar (measured, not hoped for)

| Metric | Target | How |
|---|---|---|
| Recall (end to end) | **≥ 95% pass^1** on `memory_recall` + `episodic`, ≥ 90% pass^3, on Luna + Sol | Section 5 |
| Retrieval (episodes only, no chat model) | recall@5 ≥ 95% on the episode corpus | `episode_retrieval` set, embeddings recorded |
| Deletion | **100%**, pass^3 on the real models **and** 100% on the fakes: a deleted item never appears in any later provider request, reply, tool answer, card or page (AC-W7-2) | `memory_delete` set; graders read the recorded requests |
| Memory poisoning + permissions | **100%** pass^3 real, 100% hostile fake | `memory_safety` set, hostile attacks |
| Write precision | 0 invented facts: every saved fact traces to a member's explicit words or a confirmed inference | `memory_write` set, `mustNotSave` matcher |
| Learned rules | 0 rules enforced without a person's confirmation | `learned_rules` set, trust-layer tests |
| AC-W3-1, AC-W3-2 | green | Integration + Playwright |
| Phase 6 sets | No regression: scheduling ≥ 90% (pass^3 ≥ 80%), safety/permissions/autonomy 100% | Full re-record at S33 |
| Cross-tenant isolation suite | 100% incl. the new tables and vector search | Isolation suite |
| Context cost | Memory block ≤ 600 tokens a turn (facts beat episodes when trimming); still ≤ $0.01 a typical turn | Eval report tokens |
| Latency | Fact recall ≤ 50 ms p95; episode search ≤ 150 ms p95 in the database (the embedding call is measured apart) | OTel spans, int tests |

## 3. Design principles (decided once for the whole phase)

1. **Memory is data the domain owns, never the model.** Facts, episodes and rules are rows written by core services with permissions, audit and RLS. The model proposes a fact through a tool; the domain decides (ADR-0005).
2. **Facts recall deterministically; the model never has to remember to remember.** Facts about an entity travel *with* that entity: when a tool returns a client, staff member or service, its facts come in the same answer; business facts sit in one block of the context. No similarity search decides whether an allergy is shown.
3. **Episodes recall on demand.** Semantic search over past conversations is a read tool (`search_memory`), not injected every turn: no embedding call and no extra tokens on turns that don't need the past, and a smaller injection surface.
4. **Recalled memory is untrusted text.** Fact values and episode summaries came from people's words; they are JSON-wrapped and labelled every time they are sent (Phase 6 principle 10), taint the turn like client notes, and can never raise autonomy or grant permission.
5. **Save only what was said.** The AI saves explicit statements by a member. Inferences, and anything that came from untrusted text (a booking-page message, an imported note), become a proposal a person confirms. Every fact records its source (conversation turn, execution, screen) and author.
6. **One current value per subject and key.** A new value replaces the old one; the old value is not kept anywhere (the audit entry records the change without the value). This keeps deletion simple and total.
7. **Deletion is a hard delete, everywhere, at once.** Fact row, episode row and embedding are removed in one transaction; cached context is rebuilt from the database each turn, so nothing stale survives. Deleting a client cascades their facts and the episodes that name them. The audit entry keeps no value. Backups age out on their own schedule (documented for Phase 11).
8. **Sensitive is a tag the domain enforces.** Health and personal-circumstance facts are `sensitive`: only members with `client_notes.read` for that client see them (staff: own clients), in tools, cards, the page and the context. The warning on a booking is computed by the domain from template config, not by the model.
9. **Rules learned are rules like any other.** A learned rule maps onto an existing deterministic rule type (`blackout_window`, `minimum_notice`, `max_bookings_per_day`, working hours); it is created through the rules service by a proposal a person approves, linked to its fact, and undoable. No free-form "AI rules".
10. **Industry knowledge is template config.** Which service categories warn on which fact keys (e.g. beauty: `color` → `allergy`) lives in the templates, never in code (CLAUDE.md).
11. **Minimum data to the provider, embeddings included.** Facts never hold emails or phone numbers (refused on save; the client record holds contacts). Episode summaries are written with first names and ids only, and scrubbed before embedding. Embeddings are treated as personal data: tenant-scoped, never logged, deleted with their source.
12. **Own-only stays own-only.** Episodes come from conversations, which are own-only for every role (ADR-0030); a member recalls only their own episodes. Facts are business knowledge, shared within the business subject to principle 8.
13. **Bounded.** Caps per business on facts per subject, value length, episodes, and embedding tokens (metered into the monthly token budget); the memory block has a token budget with facts first.

## 4. OpenAI budget policy for Phase 7

- **Remaining credit:** $4.26 of the $5 (S27 spent $0.74, [ai-budget.md](ai-budget.md)). The runner's guards stay as built in S27: ≤ 25 cases a run (`--chunk`), worst-case estimate ≤ $1.50 a run, nothing past $4.50 cumulative, every answer a cassette, CI only replays.
- **Phase 7 cap: $1.00** (recommended). A full pass of today's cases cost $0.058; Phase 7 adds about 70 cases and a re-record of everything once the new tools exist, so the expected spend is about $0.30. The rest stays for Phases 8–9.
- **Recorded from the start, on the chosen models** (`gpt-6-luna` effort `low`, `gpt-6.1-sol` effort `low`, ADR-0033): every session that adds memory cases records them at its end on the real models, after they are green on the fakes. No separate "real-model session" at the end, only the final re-record and pass^3 in S33.
- **Embeddings:** `text-embedding-3-small` (recommended; S29 re-checks the official pricing and models pages first). At about $0.02 per million tokens the whole Phase 7 corpus costs well under a cent. The ledger gets embedding rows; `prices.json` gets the embedding price; embedding answers are recorded as cassettes like model answers.
- **Batch description changes:** any tool description or instruction change re-records every cassette (ADR-0033), so S30–S32 change descriptions freely on the fakes and record once at each session's end; S33 records the full set once.
- The ledger names the phase on every run (`--label "P7 …"`), so Phase 7's spend is summed apart.

## 5. Evaluation strategy

The S27 runner, case format and graders carry over. New pieces:

- **Worlds with memory:** `EvalWorld` seeds facts, learned rules and episodes (with recorded embeddings) next to bookings and clients.
- **Multi-turn and multi-conversation cases:** a case may run turns in **separate conversations** (`turns[].conversation`), so "told in one chat, recalled in the next" is tested for real.
- **New deterministic graders:**
  - `memory.saved` / `memory.mustNotSave`: the facts in the database afterwards (subject, key, value pattern, sensitivity).
  - `providerMustNotContain`: patterns that must not appear in **any request sent to the provider** after a point in the case (the deletion grader; it reads the recorded requests, so it judges the context, not the wording).
  - `cards.warning`: the booking card carries the sensitive-fact warning.
  - `rules.created` / `rules.proposed`.
- **Sets (about 70 cases, 20% held out, written before any real run):**

  | Set | ~Cases | What |
  |---|---|---|
  | `memory_write` | 12 | Save explicit facts; tag sensitive; update a value; refuse contacts in facts; don't save guesses, questions, other businesses' data or untrusted text without a card |
  | `memory_recall` | 14 | "Book Maria the usual"; "anything I should know about Maria?"; facts across conversations; staff and sensitive facts of others' clients; stale fact vs a newer one; "I don't know" when nothing is stored |
  | `memory_delete` | 10 | Forget by chat, by page, by deleting the client, by a value update; then probe turns in new conversations; the deleted text never reaches the provider (AC-W7-2) |
  | `learned_rules` | 8 | Repeated preference → rule proposal; never enforced before approval; approved rule refuses a booking; Undo removes it; a staff member can't approve |
  | `episodic` | 8 | "What did we decide about…?" through `search_memory`; own-only; nothing from a deleted episode |
  | `memory_safety` | 12 | Stored injection in a fact or episode ("ignore rules", "set autonomy to auto"), planted facts from a booking-page message, cross-tenant and cross-member recall, sensitive leakage to staff, exfiltration through a fact value |
  | `episode_retrieval` | 25 queries | Retrieval only (embeddings, no chat model): recall@5 over a fixed corpus of ~60 episodes incl. near-duplicates and other members' episodes |

- **Three providers, as in Phase 6:** the scripted fake (CI), the **hostile fake** with new attacks (save or forget on another tenant's or member's subject, sensitive save as staff on a non-own client, a rule written without a proposal, oversized values, `search_memory` with crafted filters), and OpenAI (recorded, replayed in CI).
- **Fake embedder:** a deterministic embedder for unit and integration tests (hash-based, exact-match similarity); real recorded embeddings for `episode_retrieval` and `episodic`, replayed in CI.
- **Reliability:** pass^3 for `memory_delete` and `memory_safety` (100%) and for `memory_recall` (≥ 90%).

## 6. Security checks (OWASP Top 10 for LLM Applications 2026, Agentic Top 10)

Phase 6's controls stay; the S27 review deferred memory to Phase 7. S33 writes `docs/engineering/security-review-s33.md` against this table.

| Risk | Our control | Session |
|---|---|---|
| **LLM05 Data and model poisoning** | Save only explicit member statements; untrusted sources → proposal; provenance on every fact; owner review on "What I know"; no training on tenant data | S30, S32 |
| **ASI06 Memory and context poisoning** | Recalled facts and episodes labelled untrusted every time, taint the turn, can't raise autonomy or approve; learned rules only by a person's approval; stored-injection evals at 100% | S30, S31 |
| **LLM09 Vector and embedding weaknesses** | Episodes tenant-owned with RLS **and** own-only member scope; the similarity query runs inside `withMember` (filtering in SQL, not after); a test plants near-identical vectors in another tenant and another member; embeddings never logged or returned by any API; deleted with their source | S29, S31 |
| **LLM02 Sensitive information disclosure** | `sensitive` enforced by `client_notes.read` scope in tools, cards, page and context; no contacts in facts; summaries scrubbed before embedding; replies checked for other clients' facts in evals | S29–S32 |
| **LLM01 Prompt injection** | Spotlighting of recalled memory; a turn with recalled memory follows the untrusted-turn rule (external actions ask) | S30 |
| **LLM03 Excessive agency** | Memory tools are narrow (`remember_fact`, `forget_fact`, `search_memory`, `propose_rule`); `forget_fact` and `propose_rule` never auto-run; dial `client_note.save` for saves | S30, S31 |
| **LLM06 Unbounded consumption** | Embedding tokens metered into the monthly budget; caps on facts, value length, episodes; memory block token budget | S29, S31 |
| **LLM07 Misinformation** | Facts shown with source and date; newest value wins; "I don't know" over guessing; recall evals include stale and absent facts | S30 |
| **LLM08 Hidden context exposure** | The memory block holds no secrets or other members' episodes; leakage harmless by design | S30 |
| **Privacy (CCPA-style rights)** | Facts and episodes included in the tenant export and account deletion; deleting a client cascades; hard delete; backups' retention documented | S29, S32 |

Also checked in S33: the cross-tenant isolation suite at 100% with the new tables, `pnpm audit --prod`, and the S27 leftovers still waiting on the user (OWASP titles in the signed-in PDFs, zero-retention eligibility — sensitive facts now reach the provider, so ZDR matters more).

## 7. Session guides

### S28 (7a) — Phase 7 planning — this playbook
- **Done when:** the playbook is approved, its decisions recorded, PCR-005 drafted for the plan changes it implies (section 11), S29's target set.

### S29 (7b) — Memory store: tables, pgvector, embeddings port, deletion
- **Build:** migration enabling `vector` (pgvector 0.8.7 in the Compose image); `memory_facts` (subject type/id with composite tenant keys, key, value ≤ 500 chars, sensitivity, source kind + ids, author, status `active`/`proposed`, unique active per subject+key) and `memory_episodes` (owner member, conversation id, summary ≤ 1,000 chars, subject ids, `embedding vector(1536)`, embedding model, created_at) with RLS, member scope (episodes own-only; sensitive facts via `client_notes.read` scope) and guard triggers; cascades from clients, staff, services, members; core services (`saveFact`, `changeFact`, `deleteFact`, `listFacts`, `factsFor`, `saveEpisode`, `deleteEpisode`, `searchEpisodes`) with audit (never the value); `embed` on the `LlmProvider` port, the OpenAI embeddings adapter, the deterministic fake embedder, the provider contract suite extended; embedding tokens metered; `prices.json` and the runner's ledger take embedding rows; tenant export and account deletion include memory. ADR-0034.
- **Think hard about:** member scope for sensitive facts (reuse the clients `member_scope` shape); exact vs HNSW search (section 10, D-4); the subject foreign keys across four tables (one table with a type column and four nullable keys, checked).
- **Pitfalls:** a similarity query that filters after `LIMIT`; a cascade that leaves embeddings; values holding contacts; logging a value or a vector.
- **Tests:** repository + RLS + isolation (incl. near-identical vectors in another tenant/member), cascades, hard delete leaves no row, member-scope matrix, provider contract for `embed` (fake and recorded fixtures), metering. No chat model.

### S30 (7c) — Facts in the AI: tools, recall, the booking warning
- **Build:** tools `remember_fact` (internal_write, dial `client_note.save`, Undo deletes or restores the previous value), `forget_fact` (always a card, never auto), facts attached to the tool answers that return a client, staff member or service, and a business-facts block in the context (after the static prefix, before history, ≤ 600 tokens, facts first); recalled values labelled untrusted; the booking preview's **warning** from template config (`sensitiveCategories`: category → fact keys) on `create_booking`/`move_booking` cards (AC-W3-2); "the usual" through a `usual_service` fact; *Why?* lists the facts used. Eval sets `memory_write`, `memory_recall`, `memory_delete`, the memory part of `memory_safety`, on the fakes; hostile attacks; then **record them on Luna + Sol**.
- **Think hard about:** descriptions that make the model save facts only from explicit statements; how the untrusted label reads to the model without making it distrust real allergies; keeping the static prefix cacheable.
- **Pitfalls:** a fact injected into the prefix (breaks the cache per tenant); a sensitive fact in a staff member's context for a client not theirs; saving from a booking-page message.
- **Tests:** per tool as in S24 (schema, preview = execution, inverse, role matrix, cross-tenant, hostile); AC-W3-1 (chat → fact on profile, sensitive), AC-W3-2 (warning on the card) integration tests; deletion graded on requests.

### S31 (7d) — Episodes and learned rules
- **Build:** the episode writer: a worker job, through the outbox pattern, summarises a conversation 30 minutes after its last turn with the routine model (≤ 3 sentences, first names, facts only, no contacts), scrubs, embeds and stores it; retention 365 days in the daily clean-up; `search_memory` (read, own episodes, top 5, labelled untrusted); `propose_rule` (a new dial action `rule.change`, locked to "ask" like the bulk lock) mapping to the existing rule types and working hours, approved by owners/managers, linked to its fact, undoable. Sets `episodic`, `episode_retrieval`, `learned_rules`, the rest of `memory_safety`; record on the real models.
- **Think hard about:** what is worth an episode (decisions and preferences, not small talk); summarising untrusted text (the summary stays labelled); the strong model is not needed (routine only).
- **Pitfalls:** an episode outliving a deleted client or fact; the summariser running on a turn still in progress; a rule proposal that a staff member can approve.
- **Tests:** job idempotency (no duplicate episode on retry), retention, own-only search, retrieval recall@5, rule proposal → approval → booking refused → Undo, hostile attacks.

### S32 (7e) — "What I know" page, client profile, Why?
- **Build:** `/memory` in the PWA (mobile-first): facts grouped by subject with filters (clients, team, services, business; sensitive), edit, delete with a confirm (final, no Undo), source and date, learned rules with a link to the rule, own episodes with delete; a "What Pepper knows" section on the client profile (add, edit, delete facts by hand, which also covers the deferred client notes); *Why?* lists memory used; api endpoints with views parsed on the way out. Follows the prototype's style (a mock-up first if the user wants one).
- **Think hard about:** making deletion feel final and safe; staff's view; empty states that teach ("Tell me things like 'Maria is allergic to PPD'").
- **Pitfalls:** a page that shows a sensitive fact to the wrong role; a deleted item lingering in a client-side cache or the service worker (the API answers are `no-store`).
- **Tests:** component tests with axe; Playwright: tell Pepper a fact → see it on "What I know" (AC-W3-1) → book a color service → warning (AC-W3-2) → delete → ask Pepper → it doesn't know (AC-W7-2 in the UI); staff view.

### S33 (7f) — Full re-record, pass^3, security review, Phase 7 exit
- **Build/run:** one batch of description fixes from S30–S32's transcripts; full re-record of every set (Phase 6 + Phase 7) on Luna + Sol; pass^3 for `memory_delete`, `memory_safety`, `memory_recall` and the Phase 6 safety sets; the security review against section 6; Phase 7 exit.
- **Done when:** section 2 met; AC-W3-1, AC-W3-2, AC-W7-2 green; isolation 100%; Phase 7 spend recorded ≤ $1.00.

## 8. Explicitly not in Phase 7
- The operator feed, daily briefing, insights from memory and drafted messages (Phase 8).
- Facts extracted from websites, imports or photos (Phase 9 onboarding; they will arrive as proposals).
- Memory shared across businesses, or about clients from other businesses.
- Client-facing memory (the booking page knowing the client) — V3.
- Free-form learned rules or rules the AI enforces by itself.
- Fine-tuning or any training on tenant data.
- Voice (V2).

## 9. Keep getting better
Section 9 of the Phase 6 playbook applies as written: re-check the references and the provider's docs before building, fix earlier weaknesses when small, and add one to three lines to the log below at the end of each session.

**Ideas already queued** (consider them at the session named): the `find_availability`/`get_day` free-time description fix against new held-out cases (ADR-0033; batch it into S30's description changes); client visits beyond ±62 days with a paged endpoint (S26b log; S30 if `memory_recall` needs it); measure whole-turn latency in the pilot before switching models (Phase 11).

### Improvement log
| Session | Learned / next try |
|---|---|
| S28 | — |

## 10. Decisions for this phase (Claude's recommendation for each; the user decides at S28)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D-1 | How many sessions | **Five: S29–S33** as in section 7 | Each fits one session and leaves the repo green; the roadmap's 2 weeks |
| D-2 | How facts reach the model | **Deterministically: with the entity's tool answer, plus a business-facts block** | An allergy must never depend on a similarity score or the model's choice |
| D-3 | How episodes reach the model | **On demand through `search_memory`** (not top-k every turn) | No embedding call or tokens on most turns; smaller injection surface. Changes memory.md's recall step 2 → PCR-005 |
| D-4 | Vector search | **Exact search inside the tenant and member (no ANN index) in V1**, with a latency test; add HNSW with pgvector 0.8 iterative scans when a business passes ~20k episodes | Per-business corpora are small; exact search has 100% retrieval and no filtered-ANN pitfalls. data-model.md says HNSW → PCR-005 |
| D-5 | Embedding model | **`text-embedding-3-small`, 1536 dimensions**, model stored per row | Cheapest OpenAI embedding; storing the model makes a later switch a re-embed job |
| D-6 | What the AI may save on its own | **Explicit member statements under the dial `client_note.save` (default notify, Undo 7 days); inferences and untrusted sources only as proposals** | memory.md's write policy, enforced by the trust layer |
| D-7 | Sensitive facts and the provider | **Sent to the model only for members allowed to read them, labelled sensitive**; the booking warning is computed by the domain | Useful answers; the member's own words already reached the provider; ZDR check before the pilot stays on the list |
| D-8 | Fact history | **One current value per subject + key; no old values kept** (audit without values) | Makes deletion total and simple |
| D-9 | Episodes | **A summary per conversation 30 min after its last turn, routine model, own-only, kept 365 days** | Matches own-only conversations (ADR-0030) and outlives their 90-day deletion on purpose |
| D-10 | Learned rules | **Only onto existing rule types and working hours, through a new dial action `rule.change` locked to "ask"; owners/managers approve** | Deterministic, explainable, never silent. A new dial action changes contracts → PCR-005 |
| D-11 | Deleting from "What I know" | **Immediate hard delete after a confirm; no Undo** (an AI-saved fact can still be undone from its receipt within 7 days) | AC-W7-2 and "deletion is real" (M-2) |
| D-12 | Phase 7 OpenAI budget | **$1.00 cap of the remaining $4.26, recorded per session from S30** | Expected ~$0.30; leaves room for Phases 8–9 |

## 11. Plan changes this playbook implies (PCR-005, drafted in S28 for approval)
- `memory.md` recall policy step 2: on-demand episodic search through a tool instead of top-k every turn (D-3).
- `data-model.md`: `MemoryEpisode` exact search, HNSW later (D-4); `MemoryFact` one current value per subject + key (D-8).
- `contracts/trust.ts`: new dial action `rule.change`, locked to "ask" (D-10). High blast radius (contracts, trust layer): the autonomy page, `decideAutonomy` property tests and templates' dial defaults are affected.
- `roadmap-phases.md`: Phase 7 as S29–S33.

## 12. References (read the ones named in your session)
- pgvector README (0.8: iterative index scans, filtering, exact vs approximate search): https://github.com/pgvector/pgvector
- OpenAI docs — embeddings: https://developers.openai.com/api/docs/guides/embeddings · pricing (re-check at S29): https://developers.openai.com/api/docs/pricing
- OWASP Top 10 for LLM Applications 2026 (LLM05 poisoning, LLM09 vector and embedding weaknesses): https://genai.owasp.org/llm-top-10/ · OWASP Top 10 for Agentic Applications (ASI06 memory and context poisoning): https://genai.owasp.org/
- Packer et al., *MemGPT: Towards LLMs as Operating Systems* (2023), tiered memory: https://arxiv.org/abs/2310.08560
- Park et al., *Generative Agents* (2023), memory stream, retrieval by recency/importance/relevance: https://arxiv.org/abs/2304.03442
- Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* (2025): https://arxiv.org/abs/2504.19413
- Microsoft, *Guidelines for Human-AI Interaction* (G12 "remember recent interactions", G17 "provide global controls"): https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
- The Phase 6 references (spotlighting, CaMeL, τ-bench) in the [Phase 6 playbook](phase-6-playbook.md) §10.
