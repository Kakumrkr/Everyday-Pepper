# Plan Changelog

Plan versions use `MAJOR.MINOR`: MINOR for approved PCRs that keep compatibility; MAJOR for scope or architecture changes.

## 0.31 — 2026-10-24
- S34 (Phase 8a, **Phase 8 planning**): the [Phase 8 playbook](phase-8-playbook.md) (operator feed: rule-based insights, suggestions with drafts, the smart waitlist, the daily briefing; gates, sessions S35–S38, eval sets, security checks).
  - **Plan change ([PCR-006](changes/PCR-006.md), user):** insights and the morning run as `Periodic` passes, the waitlist through a queue fed from the cancellation's transaction; the model writes only drafts; `clients.email_opt_out_at` and one-click unsubscribe for rebooking nudges; `WaitlistOffer` (top 3 at once, first claim wins); tools `get_feed` and `add_to_waitlist` with a new dial action `waitlist.change`; the S33 leftovers in S36's guide batch. Phase 8 OpenAI cap $1.25.

  **Compatibility:** docs only in S34; every planned change is additive (new tables, nullable columns, enum values, optional template fields).

## 0.30 — 2026-10-24
- S33 (Phase 7f, **Phase 7 exit**): every playbook §2 gate checked ([ADR-0038](../adr/0038-what-i-know-and-the-remembered-chip.md) "S33"), [security review](../engineering/security-review-s33.md).
  - **Plan change (user):** the Phase 7 OpenAI cap goes from $1.00 to $1.55 (playbook §4); spent $1.27.
  - One guide batch (`find_availability` v2, instructions v5), the full re-record and pass^3; the business-facts block within 600 tokens as sent; pass^3 gates from §2 in the runner; a memory latency test; security patches (multer, body-parser, nodemailer).
  - Carried to Phase 8: `pasted-request-then-book` (named known miss), `who-works-saturdays` (needs working hours from a tool), `notBefore` on every day of a range, `lr-blackout` (closures as rules).

  **Compatibility:** no contract or schema change; one held-out case swapped (`in-three-days` for `in-two-days`).

## 0.29 — 2026-10-23
- M2 (maintenance, the user's decision in chat after S31, like M1): **a leaner workflow**. Tests run in tiers (the full suites once at the end, one at a time); a session that records the real model is split into "a" (build on the fakes) and "b" (probe, record once, PR); project skills `/session-brief`, `/eval-record`, `/session-close`; shorter end-of-session docs.

  **Plan change:** S32 becomes **S32a** (build) and **S32b** (record, PR), same scope and acceptance criteria. No PCR: no scope, contract or architecture change. No product code changed.

## 0.28 — 2026-10-23
- S30b (Phase 7c, recording): [ADR-0036](../adr/0036-forget-takes-recalled-answers.md) (the user chose "Turn-level + verbatim" from four options). Every eval set was recorded on Luna + Sol, and all gates are met (pass^1, 167 cases, $0.30 of the $1 Phase 7 cap).
  - **Forget takes the AI's answers that recalled a fact.** Migration 0041: in a conversation whose tool answer named the fact, every later AI answer is replaced and its reasoning items are dropped. A real model reworded a visit note past the word-for-word scrub (AC-W7-2).
  - Instructions (prompt version 3): a remembered warning goes with the proposal, and values are quoted exactly. `forget_fact` explains `factId`.

  **Additive changes:** migration 0041 (`memory_forget_recalled`, the forget trigger calls it). No contract change. Real-model cassettes are pass^1 until S33's pass^3.

## 0.27 — 2026-10-23
- S30 (Phase 7c): [ADR-0035](../adr/0035-facts-in-the-ai.md) (pre-approved at the brief: "Go ahead with your recommendations, ADR is pre-approved"). **Facts in the AI:**
  - `remember_fact`, `add_visit_note`, `forget_fact` (always asks); a value is stashed as a proposed fact, so proposals, receipts and *Why?* hold its id;
  - facts with the records tools return, by reference, filled in for each request; the business's own facts in the instructions;
  - booking warnings and the last visit by template config (AC-W3-2); "the usual" and "same as last time";
  - memory on cards and in *Why?*, read live;
  - eval sets `memory_write`, `memory_recall`, `memory_delete`, `memory_safety` (49 cases), deletion graded on the requests sent; the free-time description fix with 3 held-out cases.

  **Additive changes:** migration 0040; contracts `MemoryFactShown`, `AiMemoryView`, `TemplateSchema.memory`, `AiWhy.remembered`, explanation memory kinds, tool error `memory_paused`, `AutonomyRequest.outsideText`, `AUTONOMY_ACTIONS[...].asksAfterUntrusted`; `CleanupResult.memoryProposedFacts`; real eval runs in chunks of 20. Prompt version 2: every real-model cassette is re-recorded (next session, with the key).

## 0.26 — 2026-10-23
- S29 (Phase 7b): [ADR-0034](../adr/0034-memory-store-and-forget-everywhere.md) (the user at the brief: "Go ahead with your recommendations, start S29"). **The memory store:**
  - `memory_facts` (one active value per subject and key, visit notes, sensitive facts, staff scope);
  - `memory_episodes` (own-only, pgvector, exact search);
  - a pause switch;
  - **forget everywhere:** a deleted fact's value leaves every member's stored chats and episodes in the same transaction, limited to what the fact could have reached;
  - the `Embedder` port (OpenAI and a free hash fake, metered);
  - a cap per phase for real eval runs (Phase 7: $1).

  **Additive changes:** migrations 0037–0039, contracts `memory.ts` and embedding schemas, audit actions `memory_*`, optional `OPENAI_MODEL_EMBEDDING`, `CleanupResult.memoryPreviousValues`/`memoryEpisodes`, eval runner `--phase` (required with `--record`). No OpenAI spend.

## 0.25 — 2026-10-23
- S28 (Phase 7a, planning): the [Phase 7 playbook](phase-7-playbook.md) and [PCR-005](changes/PCR-005.md), approved by the user ("review your plan, if you can build a better plan you can, and start"). Phase 7 runs as S29–S33:
  - S29: the memory store, pgvector, embeddings, forget everywhere;
  - S30: facts in the AI, warnings, "the usual";
  - S31: episodes and learned rules;
  - S32: "What I know" and the "Remembered" chip;
  - S33: re-record, pass^3, security review, exit.

  **Quality bar:** recall ≥ 95% pass^1 (≥ 90% pass^3); deletion 100% at pass^3, graded on the provider requests and storage; memory safety 100%; AC-W3-1/2, AC-W7-2.

  **Budget:** Phase 7 cap $1.00 of the remaining $4.26, recorded per session on Luna + Sol and enforced by a new `--phase-cap`.

  **PCR-005 (design changes):**
  - episodes recalled on demand through `search_memory`;
  - exact vector search in V1;
  - values only in the memory tables, and one forget scrubs history, episodes and Undo values;
  - learned rules through a new dial action `rule.change`, always "ask";
  - visit notes;
  - a pause switch.

  memory.md, data-model.md and the roadmap are updated.

## 0.24 — 2026-10-23
- S27 (Phase 6f, **Phase 6 exit**): [ADR-0033](../adr/0033-real-model-evals-and-model-choice.md) (accepted: the user asked for the model choice "by pass rate, latency and cost, with numbers"). **Real models, chosen on evidence:** routine `gpt-6-luna` (effort `low`), strong `gpt-6.1-sol` (effort `low`), chosen from a full pass^1 of both `gpt-6-luna` and `gpt-5.4-mini` (a tie on quality; Luna's own calls 8× cheaper). Final: every eval gate met, scheduling 97% (pass^3 95%), safety, permissions and autonomy 100% at pass^3, about $0.0005 a case. **Spent $0.74 of the $5 budget**, every run in the [ledger](ai-budget.md). [Security review](../engineering/security-review-s27.md): no high findings; M1–M3 and L5 fixed.

  **Decisions (user, at the brief):** one session; unblock Undo refuses over a new booking; the routine model chosen by evals; about 120 cases with 20% held out; Sentry/Grafana at the start of Phase 11 pilot prep.

  **Changes:**
  - routing: the strong model after step 4, not 3 (ADR-0030 amended);
  - web addresses removed from the AI's text in code (`links.ts`);
  - one instruction line (claimed authority grants nothing);
  - tool descriptions: `add_todo`'s teammate id, and `move_booking`/`cancel_booking`'s booking id from `find_client_bookings`.

  **Additive changes:**
  - contracts `LlmUsage.cacheWriteTokens` (optional);
  - optional `OPENAI_REASONING_ROUTINE`/`OPENAI_REASONING_STRONG`;
  - eval runner flags `--chunk-size`, `--cassettes`, `--routine-effort`, `--strong-effort`, `--case`, `--routine`, `--strong`, `--label`;
  - the budget ledger (`evals/ledger.json` → `ai-budget.md`);
  - `eval-db.ts`;
  - guide examples' `evalSay`/`evalSkip`;
  - case `actions.nothingDone`;
  - proposals' `createdAt` from the service clock;
  - unblock's inverse keeps `bookingsInside`;
  - write outcomes carry `untrustedText`.

  **Fixed:**
  - test time bombs (fixed dates that passed in real time);
  - a race in `seedEvalWorld`;
  - the CI replay's load next to the latency gate.

  No change to phases, scope or exit criteria.

## 0.23 — 2026-10-21
- S26b (Phase 6e+, [PCR-004](changes/PCR-004.md)): [ADR-0032](../adr/0032-four-week-one-tools-and-explanation-facts.md) (pre-approved by the user at the S26b Session Brief). **Four tools owners ask for in week one** (fourteen in all): `find_client_bookings`, `list_todos`, `complete_todo` (dial `task.create`), `unblock_time` (dial `time.block`), each with its inverse where it writes; `get_day` version 2 lists block ids. **Why? says what was checked:** every write records facts from its own domain run, stored with the proposal and the receipt and shown under "What I checked".

  **Decisions (user):** a colleague's blocked time is `forbidden` for staff; facts in S26b; no new card kinds or journeys.

  **Additive changes:** db `listClientBookings`, `findTimeOff`; appointments `listClientBookingsIn`, `getTimeOffIn`; core `listTasksIn`, `changeTaskIn`, `completeTaskIn`, `reopenTaskIn`, `memberFirstNamesIn`, `TaskNotOpenError`, `ActionPreview.facts`; contracts `AiWhy.facts`; ui `factLine` and the "What I checked" block. No migration; no existing tool's version changes.

  **Amended:** ADR-0029 §2 (fourteen tools, `get_day` v2) and ADR-0028 §6 (facts from the preview). **Plan note:** the cost guard's one run is 25 cases; S27 runs eval sets in chunks of ≤ 25.

## 0.22 — 2026-10-21
- S26 (Phase 6e): [ADR-0031](../adr/0031-chat-screen-cards-why-undo-and-autonomy-settings.md) (pre-approved by the user at the S26 Session Brief). **The AI in the members' hands:**
  - the chat screen (`/chat`): streamed plain text, resume with `Last-Event-ID`, Stop and cancel on leaving, suggestion chips, the AI off/paused/fallback states;
  - cards in `@pepper/ui` shared with the future feed (change/confirmation/receipt, slot picker, client choice, booking, day, plan), the *Why?* sheet, Undo with its window and "the client was already emailed";
  - the Autonomy page (`/autonomy`) and Home's "Needs your OK" and "Done for you".

  **Decisions (user):** migration 0036 recorded in ADR-0031 as an ADR-0028 amendment without a PCR; staff may undo what a lead approved for them; jsdom, Testing Library and axe-core as dev-only test dependencies; managers change autonomy (ADR-0028 over the prototype's copy); the chat's Redis polling stays until Phase 11.

  **Additive changes:**
  - contracts `ai-views.ts` (proposal and receipt views, *Why?*, approve and undo answers, chat status), an optional `summary` on change cards, five error codes;
  - db migration 0036 (`ai_action_proposals.tool_version`; `ai_action_executions.requested_by_user_id` and `summary`, the staff scope widened to the requester), core `ownMessageText`, `memberFirstNames`, `actionMessages`, `getActionOfProposal`;
  - ai `approvalRefusal`, `shownPreview`, `ToolDeps.requester`;
  - api `/v1/ai/*`, `/v1/autonomy`, `/v1/chat/status`, `AI_SCRIPTED_PROVIDER=e2e` (refused outside CI or local development, and next to a key).

  **Amended:** ADR-0028 (tool version, requester, who may undo) and ADR-0029 (`ToolDeps.requester`). **Hardened:** `ScreenLinkSchema` refuses `//host`; a lint rule bans raw HTML and Markdown rendering. **Fixed:** a lead approving a staff member's "remind me"/"book me" made "me" the lead; resumed turns whose event log expired lost their cards.
- [PCR-004](changes/PCR-004.md) (approved by the user): **S26b** before S27 adds four tools: `find_client_bookings`, `list_todos`, `complete_todo`, `unblock_time`. No change to phases, scope or exit criteria; S27's eval budget grows by about $0.20.

## 0.21 — 2026-10-21
- S25 (Phase 6d): [ADR-0030](../adr/0030-agent-loop-and-conversations.md) (pre-approved by the user at the S25 Session Brief). **The agent loop and chat:**
  - a transport-agnostic `Turn` in `@pepper/ai` (`startTurn`, `recoverTurn`): cache-friendly context, history trimmed by whole turns with untrusted labels kept, routing, limits (6 steps, 20 s, 5 writes, `turn_limit`), parallel reads and serial writes through `dispatchToolCall` only, a circuit breaker and a deterministic fallback;
  - conversations (tables `conversations`, `conversation_turns`, `conversation_messages`, migrations 0034–0035): own-only for every role, 90-day retention in the daily clean-up;
  - a per-business monthly token budget reserved atomically before every model call (`AI_MONTHLY_TOKENS`, default 5M, soft 80%) and Redis rate limits per member, business and address;
  - `POST /v1/chat/turns` streaming typed SSE events, resumable with `Last-Event-ID`, cancel and history endpoints; OpenTelemetry spans without contents.

  **Decisions (user):** own-only conversations, 90-day retention, 5M tokens a month, turns keep running when the connection drops, and the amendments below recorded in ADR-0030 without a PCR. **D8 decided: SSE.**

  **Additive changes:** contracts `chat.ts`, permission `ai.chat` (every role, own scope), error codes `turn_in_progress` and `conversation_not_found`, tool error code `turn_limit`, `redactContacts`; core conversation services, `reserveLlmTokens`, `findToolCallResult`, `CleanupResult.conversations`; db `reserveUsage`/`settleUsage`, `insertSeedUser`; `@pepper/ai/config` entry point; `@opentelemetry/api` in `@pepper/ai`. **Amended:** ADR-0027 (eval cases name a seeded `world` and judge `expect.actions`; the per-case `tools` list and the S22 sample tools are gone) and ADR-0029 (the idempotency key adds the loop's step; reads may mark answers untrusted). **Fixed:** the web forwarder cut streamed answers at its 10 s timeout and dropped `Last-Event-ID`. No change to phases, scope or exit criteria.

## 0.20 — 2026-10-21
- S24 (Phase 6c): [ADR-0029](../adr/0029-tool-registry-and-tools.md) (pre-approved by the user at the S24 Session Brief). **Tools:** the tool registry and ten tools in `@pepper/ai`:
  - reads: `find_availability`, `find_clients`, `get_day`, `get_booking`, `list_services_and_staff`;
  - writes, through the trust layer: `create_booking`, `move_booking`, `cancel_booking`, `block_time`, `add_todo`.

  **The trust layer runs every preview in a savepoint it always rolls back** (preview = execution). **Additive changes:**
  - the domain services' transaction-taking `*In` variants (booking writes in a savepoint), `reinstateBookingIn`, `withdrawTaskIn`;
  - `queueBookingEmail` moved into appointments (the api delegates);
  - contracts `tool-cards.ts` (tool error codes and cards), audit action `task.deleted`;
  - core `getProposal`, `getAction`, `ConcurrentActionError`;
  - db `findClientsByIds`, `findProposal`, `findExecution`, `createDatabase({ onQuery })`;
  - the `packages/ai` layer rule allows db and appointments.

  **Fixed:** a time long past no longer makes the alternatives query fail (a 500 on the calendar too). **Plan:** S25's ADR is renumbered ADR-0030. No change to phases, scope or exit criteria.

## 0.19 — 2026-10-21
- S23 (Phase 6b): [PCR-003](changes/PCR-003.md) (approved by the user at the S23 brief): `booking.cancel` and `task.create` join the autonomy dial; a tool call follows the strictest of its actions; the bulk lock goes by recipients (> 10), not by action name. [ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md) (accepted by the user): the trust layer — `decideAutonomy` inside the domain, autonomy settings with an "Ask me first for everything" switch, proposals with a state fingerprint (stale → superseded, never run), people-only approval with the approver's role re-checked, receipts with undo windows per action, a 2-minute "undo send" grace on AI-queued client emails, and the `ActionRunner` port for S24 tools. Additive changes: tables `autonomy_settings`, `ai_action_proposals`, `ai_action_executions` (migrations 0032–0033), audit actor `ai_on_behalf_of` and five trust audit actions, outbox status `cancelled`. No change to phases, scope or exit criteria.

## 0.18 — 2026-10-20
- S22 (Phase 6a): the [Phase 6 playbook](phase-6-playbook.md) (confirmed by the user) splits Phase 6 into S22–S27 and sets its differentiators, quality bar, design principles, eval strategy and security checklist. **OpenAI budget: $5 in total for Phase 6, real calls only in S27** (user). [ADR-0027](../adr/0027-llm-provider-port-and-evals.md) (accepted): the provider-neutral LLM contracts (`contracts/ai.ts`, additive), the new `@pepper/ai` package with the `LlmProvider` port, the OpenAI adapter on the Responses API (official `openai` SDK 7.32.0, pinned, only in `packages/ai`; `store: false`), the scripted fake, strict tool schemas from Zod, metering, and the eval runner with cassettes and a budget guard. New config `OPENAI_API_KEY`, `OPENAI_MODEL_ROUTINE`, `OPENAI_MODEL_STRONG` (optional; nothing reads them in the apps until S25). No change to scope or exit criteria.

## 0.17 — 2026-10-20
- M1 (maintenance, after S21): workflow only, no plan or product change. `STATUS.md` split into a short status, [session-log.md](session-log.md) and [decisions.md](decisions.md) (moved verbatim); `CLAUDE.md` gains checkpoints after each task and a rule for generous test time limits; in cloud sessions local Playwright uses CI's headless shell and Docker pulls through Google's mirror (session-start hook).
- S21 (Phase 5c): [ADR-0026](../adr/0026-tasks-and-web-push.md) (accepted by the user): to-dos (`tasks`, `/v1/tasks`, the To-dos card on Home; staff see their own, owners and managers all) and Web Push for the team (`push_subscriptions`, `/v1/push`, the outbox type `push`, `web-push` 3.6.7 in the worker; pushes for booking-page activity and due to-dos, never naming a client; the switch on Home). Additive contract changes: permissions `tasks.read`/`tasks.manage` (staff scope `own`), audit actions `task.created`/`task.updated`, error codes `task_not_found`, `task_assignee_not_member`, `push_unavailable`, config `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`. The [Phase 5 security review](../engineering/security-review-s21.md) found no high-severity issues; two medium ones were fixed. **Phase 5 complete.** No change to phases, scope or exit criteria.

## 0.16 — 2026-10-20
- S20 (Phase 5b): [ADR-0025](../adr/0025-booking-reminders-team-emails-and-cleanup.md) (accepted by the user; its six decisions were chosen at the S20 Session Brief): booking reminders 24 h before, planned in a `booking_reminders` table kept in step in each booking's transaction and sent by a worker job every minute through the outbox (AC-W6-1); none for a booking made or moved less than a day ahead. Team-made bookings email the client (confirmed and moved with a new reschedule/cancel link, cancelled), with an "Email the client" checkbox, ticked by default (additive `notifyClient` on `POST/PATCH /v1/bookings`). A daily clean-up deletes booking requests 24 h after they expire (closes S18 L7) and sent/dead outbox rows after 30 days. A read-only `job_scan` policy (reminders, clean-up) joins the cross-business scans. Reminders are Postgres-driven instead of the BullMQ delayed jobs first sketched in the architecture doc. No change to phases, scope or exit criteria.

## 0.15 — 2026-10-20
- S19 (Phase 5a): [ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md) (accepted by the user; its five decisions were chosen at the S19 Session Brief): the transactional outbox (`outbox_messages` with RLS, the `outbox_dispatch` index read through the read-only `outbox_scan` policy), content sealed with AES-256-GCM under a new required `OUTBOX_SECRET` (api and worker), delivery in the worker through BullMQ 6.3.11 with a lease, retries in Postgres and an alert when a message is given up. The booking page's confirmed/moved/cancelled emails move onto it (ends the temporary exception of 0.13); the code email stays direct. The SMTP mailer moves from the api to `@pepper/runtime`. **D4 resolved: Resend for the pilot.** Phase 5 split: S19 outbox, S20 confirmations for team-made bookings, reminders (AC-W6-1) and expired-request cleanup, S21 tasks and push notifications. No change to scope, contracts' existing shapes or exit criteria.

## 0.14 — 2026-10-20
- S18 (Phase 4e): [ADR-0023](../adr/0023-pwa-offline-and-phase-4-exit.md) (accepted by the user): an installable app (manifest, icons) with a hand-written service worker that caches only a static offline page, linked from the signed-in app only; security headers on every web response and `no-store` on forwarded api answers (the two medium findings of the [Phase 4 security review](../engineering/security-review-s18.md); no high ones); axe in Playwright on the key screens (`@axe-core/playwright` 4.13.0, e2e only); AC-W8-1 in Playwright. **Phase 4 complete.** No change to phases, scope, contracts or exit criteria.

## 0.13 — 2026-10-20
- S17 (Phase 4d): [ADR-0022](../adr/0022-public-booking-page.md) (accepted by the user): public booking page with email verification. Implements PCR-001 (brand color, AA-adjusted tokens). Additive changes: `tenants.brand_color`, `booking_verifications`, `bookings.manage_token_hash`, the read-only `public_lookup` policy, `/v1/public/businesses/:slug/*`, `PUT /v1/tenant/booking-page`, audit action `tenant.updated`, new error codes. A dev SMTP sender (nodemailer → Mailpit) is used directly by the api until Phase 5's outbox (a temporary exception to "side effects through the outbox", recorded in the ADR). No change to phases, scope or exit criteria.

## 0.12 — 2026-10-19
- S16 (Phase 4c): [ADR-0021](../adr/0021-setup-screens.md) (accepted by the user): Services and booking rules, Team with staff pages (details, weekly hours, time off), Clients list and profile, Team screen on the design system. Additive api changes: `PUT /v1/clients/:clientId` (audit `client.updated` with only the changed field names), `clientId` filter on `GET /v1/bookings`, `defaults` on `GET/PUT /v1/rules` (contracts: one `RuleDefaultsSchema`; the template schema is renamed `TemplateRuleDefaultsSchema`). No change to phases, scope or exit criteria.

## 0.11 — 2026-10-19
- S15 (Phase 4b): [ADR-0020](../adr/0020-booking-screens-and-client-lookup.md) (accepted by the user): booking screens on the calendar (new booking, booking sheet, alternatives, waitlist), with Radix Dialog as planned. Implements two earlier decisions: staff find any client by exact email or phone (user, 2026-10-17; migration 0020 widens the clients read policy for that exact contact only; `POST /v1/clients/lookup`; optional `clientContact` on bookings and waitlist entries, additive), and outcomes rule (b): `completed`/`no_show` final for staff, correctable by owners and managers (Claude's recommendation, built by default because open question 1 was still unanswered). No change to phases, scope or exit criteria.

## 0.10 — 2026-10-18
- [PCR-002](changes/PCR-002.md): the product is renamed from **Floty** to **Pepper** everywhere (UI, docs, mockup, `@pepper/*` packages, database roles and names, cookies, telemetry), and the theme is **Pepper green + chili accent** (new `accent` tokens; "done" teal; plum sample business). No change to phases, scope or exit criteria.

## 0.9 — 2026-10-18
- S13 (Phase 3d): [ADR-0018](../adr/0018-industry-templates.md) accepted; **Phase 3 complete**.
- Session plan: Phase 4 split into **S14** (design system, app shell, calendar day view), **S15** (booking screens), **S16** (clients, services, team screens), **S17** (public booking page + email verification), **S18** (Phase 4 exit). Proposed by Claude at S14, which the user asked to go ahead with. No change to phases, scope or exit criteria.
- S14 (Phase 4a): [ADR-0019](../adr/0019-design-system-and-app-shell.md) (proposed): `@pepper/ui` with Tailwind v4 as planned, self-hosted fonts, the app shell, time-zone helpers shared through contracts, and a 500-item cap with `truncated` on the bookings, busy-time and availability answers (additive contract change, closes the S13 finding).

## 0.8 — 2026-10-17
- S12 (Phase 3c): [ADR-0017](../adr/0017-bookings-clients-and-waitlist.md) (accepted by the user): bookings with a `booking_occupancy` exclusion constraint (buffers included), staff-scoped RLS (AC-W9-1), statuses `confirmed`/`completed`/`no_show`/`cancelled`, owner/manager override, alternatives for refused times, idempotency keys; a minimal `clients` table in core; the waitlist model and API. Decided by the user at the S12 Session Brief: clients table now, occupancy table, no "pending", the override, the waitlist window format and its API. Data model: "Customer" is named "client" (as the permissions and UI already were), and booking sources `owner`/`staff` became `team`. No change to phases, scope or exit criteria. After S12 the user chose: staff may find any client by exact email or phone (built in Phase 4); staff still cannot add clients.

## 0.7 — 2026-10-17
- S11 (Phase 3b): [ADR-0016](../adr/0016-booking-rules-and-availability.md) (accepted by the user): versioned booking rules (slot interval, minimum notice, maximum advance, daily cap, blackout windows as local dates) per business or staff member, stored in `booking_rules`; the pure availability engine; `Intl`-based time zones. Storing rules in S11, the defaults and local-date blackouts were approved by the user at the S11 Session Brief. Working hours, buffers and staff–service eligibility stay in the base data (no duplicate rule types). No change to phases, scope or exit criteria.
- S10 (Phase 3a): [ADR-0015](../adr/0015-appointments-base-data.md) (accepted by the user): services (price "from", optional "to", in cents), staff members optionally linked to one membership, weekly hours in local time, time off in UTC; a new L2 package `@pepper/appointments`; staff manage only their own time off; composite `(tenant_id, id)` foreign keys for references between tenant tables.
- Data model: a staff member links to a membership (`staff_members.membership_id`) instead of `memberships.staff_member_id`, approved by the user at the S10 Session Brief. No scope change.
- Session plan: Phase 3 split into **S10** (base data), **S11** (rules + availability), **S12** (bookings + waitlist), **S13** (templates + exit), approved by the user. No change to phases, scope or exit criteria.

## 0.6 — 2026-10-17
- S9 (Phase 2c, part 2): [ADR-0014](../adr/0014-invites.md) (accepted by the user): single-use, 7-day invite links bound to the invitee's email, hashed tokens, at most 20 open invites per business. **Phase 2 complete** (exit criteria met; S9 merged at the user's request).
- S8 (Phase 2c): [ADR-0013](../adr/0013-roles-audit-log-and-metering.md) (accepted by the user): permission matrix in core, MFA for managers as well as owners, append-only audit log, usage meters, at most 5 businesses per owner, domain services in core. Matrix, manager MFA and the limit approved by the user at the S8 Session Brief.
- Session plan: Phase 2c split into **S8** (roles, audit, metering, team API) and **S9** (invites, Team screen, `/security-review`, Phase 2 exit), approved by the user. No change to phases, scope or exit criteria.

## 0.5 — 2026-10-16
- D10 resolved by the user: **SeaweedFS** as the dev/CI S3-compatible server → [ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md). Added to Compose in Phase 4.
- S7: [ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md) (accepted by the user): auth tables, user-keyed "my businesses" policy, session tenant context, web forwarding. Implements ADR-0007 within the approved plan; no scope change.

## 0.4 — 2026-10-16
- Mockups of all key screens approved (S1 + S2). Design tokens recorded in `product/ux-principles.md`. Phase 0 complete.
- [PCR-001](changes/PCR-001.md): the booking page uses the business's own brand color, picked in onboarding (W1, W8).

## 0.3 — 2026-10-16
- User approved all planning docs (no changes).
- ADR-0001…0006 accepted; ADR-0007 (Better Auth) and ADR-0008 (Drizzle) added and accepted, resolving D2/D3.
- Working name **Pepper**.
- Session protocol: one feature-sized goal per session, mandatory Session Brief at start, planned-sessions list in STATUS.md.

## 0.2 — 2026-10-16
- Initial planning set: product, architecture, engineering, plan docs, competitor audit, CLAUDE.md.
- Scope: all appointment-based US industries (Beauty, Wellness & fitness templates), owner/staff AI, public booking page, email-only messaging, no payments, voice in V2.
- Stack: Next.js, NestJS, OpenAI, PostgreSQL + pgvector, Redis + BullMQ, Google Calendar, S3-compatible storage, Sentry + OTel; lean deployment (Docker → VPS → AWS).
- ADRs 0001–0006 proposed.

## 0.1 — 2026-10-16
- First draft (salon-only, superseded).
