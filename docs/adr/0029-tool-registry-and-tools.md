# ADR-0029: The tool registry and the first ten tools

- **Status:** Accepted (user, 2026-10-21: pre-approved at the S24 Session Brief, "Go ahead with your recommendations, ADR-0029 is fine … I'm pre approving the ADR"; drafted by Claude in S24). S25's planned ADR becomes ADR-0030.
- **Date:** 2026-10-21
- **Builds on:**
  - ADR-0005 (the model proposes, the domain decides);
  - ADR-0017 (member scope), ADR-0020 (client lookup), ADR-0024/0025 (outbox, booking emails);
  - ADR-0027 (provider port, strict schemas, evals);
  - ADR-0028 (the trust layer and its `ActionRunner` port);
  - the [Phase 6 playbook](../plan/phase-6-playbook.md) principles 1–5, 10, 11 and §7 "S24".

## Context
S24 gives the AI its hands: about ten tools over the business, as thin adapters to the same domain services as the screens. They must hold up against a compromised model (playbook principle 2), show exactly what they will do (D-1), stay within the member's own permissions (D-4), and never hand a client's contact details to the provider (D-5).

Guidance re-checked at the brief:
- OpenAI's function-calling guide:
  - strict schemas;
  - fewer than 20 tools a turn;
  - descriptions that pass the "intern test";
  - never make the model fill in what the code knows.
- The OWASP Top 10 for LLM Applications 2026 (August 2026): LLM01 prompt injection, LLM02 sensitive information disclosure, LLM03 excessive agency (up from #6).

## Decision
1. **Where the tools live:** `@pepper/ai` (`packages/ai/src/tools`).
   - The layer rule for `packages/ai` now allows `@pepper/db` (`withMember`, transaction types, read repositories such as the business's time zone) and `@pepper/appointments`, besides contracts and core, as the dependency map already said.
   - No SQL is written in `packages/ai`.
   - Industry templates (L3) are never imported: the app passes `templateRuleDefaults` and the autonomy defaults in `ToolDeps`.
2. **The registry** (`registry.ts`).
   - **Ten tools:**
     - reads: `find_availability`, `find_clients`, `get_day`, `get_booking`, `list_services_and_staff`;
     - writes: `create_booking`, `move_booking`, `cancel_booking`, `block_time`, `add_todo`.
   - **`toolDefinitions()`** is static, so it is a cacheable prefix.
   - **`dispatchToolCall(deps, turn, call)`** is the one entry point from the model:
     - it parses the arguments twice (the provider's strict JSON Schema, then Zod);
     - it takes the business, the member and their role from `ToolDeps` (the session) only;
     - reads run in one member transaction as `via: 'ai'`;
     - writes go through `requestAction`;
     - it never throws for anything the model did.
   - **No tool chains writes:** one call is one action.
3. **Every write tool implements `ActionRunner` through `writeRunner`.**
   - Preview and execute run the very same `perform`, which calls the domain's transaction-taking variant.
   - The trust layer now runs every preview in a **savepoint it always rolls back** (`dryRun` in `ai-actions.ts`).
   - So the preview *is* the execution, rolled back: the typed diff (before and after, in ids, local times and display names) and the would-be emails (template and client id) are what the domain did. They are not a separate estimate (D-1).
   - The fingerprint covers only what the tool touches: the payload, the touched rows' `updated_at`, the outcome and the emails (S23's log). A rule that changes nothing about the outcome doesn't make an approval stale; one that does, does.
4. **Transaction-taking services** (ADR-0028 §9).
   - The `*In(tx, actor, …)` variants:
     - `createBookingIn`, `changeBookingIn`, `getBookingIn`, `listBookingsIn`;
     - `findAvailabilityIn`;
     - `addTimeOffIn`, `removeTimeOffIn`, `listTimeOffBetweenIn`;
     - `listServicesIn`, `listStaffIn`;
     - core `createTaskIn`, `findClientsByNameIn`, `clientNamesIn`.
   - The screens' functions keep their signatures and wrap them, and the existing suites are unchanged and green.
   - **Booking writes run in a savepoint,** so an overlap (`23P01`) or a taken idempotency key rolls back only itself. The trust layer's transaction stays usable, and the 3 nearest times are read in it.
   - **For Undo:**
     - `reinstateBookingIn` brings back a cancelled booking, only before it starts and while its time is still bookable;
     - `withdrawTaskIn` takes back an untouched to-do (new audit action `task.deleted`).
5. **The client's email is a dial action of its own.**
   - A write that may email the client lists `message.confirmation` after its own action, unless the model passed `emailClient: false`. `null` means the screens' default: email.
   - The email is queued with `queueBookingEmail` (moved from the api into appointments), held for `AI_EMAIL_GRACE_SECONDS`, and its id goes on the receipt.
   - Undo never emails the client; the receipt says if an email had already left (S26).
6. **Answers the model can act on.**
   - Domain errors become stable codes (`contracts/tool-cards.ts`): `invalid_arguments`, `unknown_tool`, `not_found`, `forbidden`, `slot_unavailable` (with the 3 nearest times in local time and a SlotPicker card, AC-W2-1), `not_changeable`, `too_late`, `conflict`, `internal`.
   - Each comes with one plain instruction, never the error's text.
   - Another business's id is `not_found`, exactly like a made-up one.
   - Cards are typed, for S26: `slot_picker`, `client_choice`, `change` (proposed or done, with the fingerprint to approve with), `booking`, `day`.
7. **Descriptions are prompts.**
   - Each tool writes a guide in fixed parts: use, don't use, returns, examples.
   - Every argument is described, and dates and times are `YYYY-MM-DD` and 24-hour `HH:MM` in the business's time zone. The tools convert them with the shared helpers, including DST gaps and repeats.
   - A lint test holds the guides to this. The examples become generated eval cases (`toolEvalCases`), and each example's literal values must fit the tool's own schema.
8. **Minimum data to the model.**
   - Answers carry ids, local times, service and staff names, and a client's **short name**: the first name (letters only, at most 20) and the last initial. That also leaves no room for instructions typed into a name on the booking page.
   - `find_clients` matches names only, never emails, and refuses a contact as the query.
   - No answer holds an email address or a phone number; a test scans every read as every role.
9. **Approve and undo by id** (`approveToolProposal`, `undoToolAction`).
   - The stored proposal or receipt is loaded (core `getProposal`, `getAction`) and the runner is built from the stored payload, never from what the caller sends.
   - People only, as ADR-0028 says.
10. **A copy of a tool call that loses a race** (same idempotency key) gets `ConcurrentActionError` from the trust layer, and dispatch asks once more, so every copy answers with the one execution.
11. **The hostile fake** (`hostile.ts`).
    - **A catalogue of attacks against every tool:**
      - another business's ids;
      - `tenantId`, `userId`, `role`, `via` and `override` smuggled in;
      - non-JSON and wrongly shaped arguments;
      - contacts;
      - made-up tools to approve, undo or change autonomy;
      - past times, UTC instead of local time.
    - **A `ScriptedProvider` that plays them,** for S25's loop.
    - **The suite is a 100% gate,** as the owner and as staff, and nothing may change in either business.
    - **Direct attacks on the trust layer:**
      - the AI approving, rejecting or undoing;
      - forged fingerprints;
      - another business's or unheld outbox links;
      - more than 10 recipients;
      - a retry storm;
      - a card's ids from another business.
12. **Per-tool budgets.**
    - On a busy business (2,000 bookings), each tool has a statement budget (deterministic; an N+1 fails at once) and a p95 gate at 3× the 300 ms target.
    - Measured p95: reads 7–21 ms, writes (dry run and proposal) 22–63 ms.
    - `createDatabase` gains an optional `onQuery` hook.

## Consequences
- **Gains:**
  - D-1 holds by construction: what a card shows is what the domain did, rolled back. A contract test per tool compares the proposal with the execution, and mutation checks prove it bites.
  - Every inverse is proven to restore the state and take back the unsent email.
  - The hostile fake found two real bugs before any model ran:
    - a time long past built an inverted alternatives range (a 500 on the calendar screen too, fixed with a test first);
    - `get_day` answered an empty day for another business's staff member (now `not_found`).
  - Owners and staff get the same AI, limited to exactly what their screens allow (AC-W2-4 through the tools).
- **Costs and risks:**
  - `packages/ai` now depends on db and appointments: its unit coverage excludes the database-bound registry and runner, which the Postgres suites prove (57 tests).
  - A tool whose schema changes between versions can't re-parse an old proposal's payload. It must bump `version` (the fingerprint changes, so the proposal reads as stale), and S26 should show such a proposal as expired.
  - A service or staff name an owner typed with a phone number in it would fail the ids-only guard on a preview (`internal`). This is rare; logged.
  - Undoing a move whose email was taken back leaves the client's earlier reschedule link dead, because the move replaced it. Logged for S26.
  - Undoing a booking whose confirmation already left cancels it silently: the receipt must say so (S26).

## Alternatives considered
- **Tools in their own package** (`packages/agent-tools`): a cleaner unit-coverage story, but a third AI package before the loop exists. The dependency map already put the registry in `@pepper/ai`.
- **A preview computed separately from the execution** (a "what would happen" function per tool): no savepoints, but two code paths that can drift, which is exactly what D-1 promises won't happen.
- **Fingerprinting everything the preview read** (the rules, every booking of the day): stale approvals whenever anything nearby moved, as S23's log warned.
- **Letting the model pass staff or user ids for identity:** the tools take staff member ids only as the *target* of an action (whom to book), validated by `can()` and RLS. Who acts always comes from the session.
- **A generic "update booking" tool:** fewer tools, but a wider blast radius and vaguer descriptions (playbook principle 3).
