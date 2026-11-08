# ADR-0062: The support console's operator role, logged in the database

- **Status:** Accepted. Pre-approved by the user at the S59.2 brief on 2026-11-07 ("Preapproved with your recommendations").
- **Date:** 2026-11-07
- **Builds on:** ADR-0010 (RLS, the services' role), ADR-0012 (global users), ADR-0013 (permissions, the audit log), ADR-0017 (member scope), ADR-0024 (outbox), ADR-0025 (job scans), [PCR-010](../plan/changes/PCR-010.md) (our own support system)

## Context
S59 gave every business support threads that only its own members can read. Someone at Pepper has to answer them: they need to see every business's open requests, and the public form's. Until now nothing in Pepper reached across businesses for a person. Only the worker's read-only `job_scan` did, and only for jobs. The services' role can't bypass RLS (ADR-0010), and a tenant's data must never be reachable from a request body. An operator who reads a request is reading a business's words, so the business should be able to see that it happened, and Pepper must be able to say who read what.

## Decision
1. **Who is an operator (D-2).** An operator is an account listed in `platform_operators`. Only the `operator` script adds or removes accounts (`pnpm --filter @pepper/db operator grant <email> "<who and why>"`, `revoke`, `list`). The script runs as the migration role. The services' role has no privilege on that table. It asks `is_platform_operator(user)`, a definer function. Nothing over HTTP can grant the role.
2. **The guard.** `OperatorGuard` (`/v1/ops/*`) requires a session and the grant, checked on every request so a revoked operator is refused at once. It also requires two-step verification, as for owners and managers. Any other account, an owner included, gets 403 `forbidden`, and the web's `/ops` shows "not found". The operator's identity comes from the session only.
3. **Every access is logged in its own transaction (D-3).** `withOperator(db, { operatorUserId, action, targetId }, work)` opens a transaction. It first calls `begin_operator_access`, a definer function that:
   - checks the grant;
   - refuses a second operator in the same transaction;
   - writes a row to `operator_access_log` with the transaction id (`txid_current()`);
   - names the operator in `app.operator_id`.

   The new policies (`operator_read` on `support_threads` and `support_messages`, `operator_access` on `support_notes` and `public_support_requests`) pass only while `current_operator_id()` finds that log row in the same transaction for a still-granted operator. Setting `app.operator_id` by hand opens nothing. So the database itself guarantees that no support row is read across businesses without its log row. If the work fails, the access and its row roll back together.
4. **Support rows only.** An operator transaction sees no clients, bookings, members, audit entries or tenant rows. The inbox gets business names through `operator_business_names(ids)`, which returns the id and name and nothing else. To change a business's thread (reply, status, "seen"), the transaction is first bound to that business with `setTransactionTenant`, using the tenant read from the thread row. The write then goes through the business's own policies and audit log.
5. **Two logs (D-4).**
   - `operator_access_log` is global, ids only, and is kept after the business or the account is deleted. It records who did what to which request: inbox read, thread read, reply, note and status, and public request read, note and status.
   - The business's own `audit_log` gets an `operator` actor with no person named. It records `support_thread.seen`, `support_thread.replied` and `support_thread.status_changed`.
   - The requester's thread shows "Seen by Pepper" with when (`support_threads.pepper_seen_at`).
6. **Notes.** `support_notes` is a global table pointing at either a thread or a public request. It has forced RLS with only the operator policy, so no member transaction ever sees a note, even an owner's. It is append-only for the services and is deleted along with its request. Notes are not in the business's export: they are the team's working notes, not the business's data.
7. **Public requests (D-5).**
   - `public_support_requests` now has forced RLS. The form may only insert, with no `RETURNING` and no `ON CONFLICT`; a reference that is already taken shows up as a unique violation. Only an operator reads a request or changes its status (`open` → `answered` → `solved`).
   - The console never sends mail to a typed address, keeping AC-X-17's promise. "Reply by email" opens the team's own mail client with the reference in the subject, and the operator then marks the request answered. S59.3 brings those answers back.
8. **Statuses (D-5).** Business threads keep their three statuses, and the console can set any of them. "Solved" by an operator is the same "Solved" the requester sees; there is no separate "closed".
9. **Placement (D-6).** `/ops` lives in the web app with its own frame, outside the business shell, and is not indexed. Its api is `/v1/ops/*` in the support module.

## Consequences
- The business and Pepper can both see when an operator looked at a request, and the database refuses to show a support row across businesses without its log row. This is the evidence C11 and the pilot's security review need.
- An operator account is a high-value target. Mitigations so far: grants only by the script, two-step verification, every access logged, and support data only. Not done yet: a shorter session for operators, a second factor at each console sign-in, and alerting on unusual access volume. These are noted for S60's security review.
- Times in the console are shown in UTC; the team works across zones.
- The inbox has no pixel baseline: it lists every business's open requests, so its content changes from run to run. Its words, order and tap targets are tested; the thread and public-request views have baselines.
- Saved replies, auto-close after 7 quiet days, the same-day overdue reminder, 👍/👎 after close, and screenshots move to S59.2.2 (the brief's split, PCR-008). S59.4's metrics page will reuse `withOperator`, with a new action.

## Built (S59.2)
- db: migration 0068 (`platform_operators`, `operator_access_log`, `support_notes`, the public request status, `pepper_seen_at`, the `operator` audit actor, the four functions and policies), `withOperator`, `isPlatformOperator`, the console repositories, `operators.ts` and `operator-cli.ts`.
- contracts: the console's schemas, `PublicSupportStatus`, `SupportThread.seenByPepperAt`, the `operator` actor and two audit actions.
- core: `services/operator-support.ts`, and `answerInThread` shared with `answerSupportThread`.
- api: `OpsController` and `OperatorGuard`.
- web: `/ops`, `/ops/threads/[id]`, `/ops/requests/[id]`, and "Seen by Pepper" on the thread.
- Tests:
  - `operator.int.test.ts` (db);
  - `isolation.int.test.ts` (the policies);
  - `operator-support.int.test.ts` and `operator-support.test.ts` (core);
  - `ops.controller.test.ts`;
  - `ops.test.ts` (web);
  - `ops.spec.ts`;
  - the ops shots in `screens.spec.ts`.

## Part 2 (S59.2.2, preapproved at its brief)
1. **Saved replies (AC-X-23).** `support_saved_replies` is platform data: forced RLS, only the `operator_access` policy, at most 100 (an advisory lock holds the count). The access log has `replies.read` and `replies.write`. In a request, "Use a saved reply" adds its text below the operator's draft, with `{first name}` filled in, for them to edit and send; it is never sent by itself.
2. **The support job (AC-X-24/25).** The worker runs it every 5 minutes (`SUPPORT_POLL_MS`). It scans with `withJobScan('support')`, a read-only `job_scan` policy on threads and their messages, then checks each thread again under its lock, bound to its business.
   - A request waiting on Pepper for 4 h (the same-day promise) sends one reminder to `SUPPORT_EMAIL` per wait (`overdue_reminded_at`), through the business's outbox. A request that opens again starts a new wait, counted from `status_changed_at`, which moves only when the status changes. Without a team address nothing is marked.
   - A request the team answered that has been quiet for 7 days (since its last message or status change) is solved with `solved_by = 'auto'`, audited as `system`, and its opener is emailed once. A request waiting on Pepper is never closed.
   - Public requests have no business: three definer functions (close, list overdue, mark one) fix the 7-day and 4 h windows and refuse a "now" ahead of the database's clock. Each reminder is marked and mailed in its own short transaction, so a refused email undoes only its own mark.
3. **"Did this help?" (AC-X-26).** Only the opener rates, once the request is solved; the answer can change; a reply that reopens it clears the answer (`setSupportThreadStatus`). It is audited as `support_thread.rated` with the answer only. The console shows it on the request and in the Solved view. Thumb icons always come with their words (DESIGN §6: no emoji).
4. **Screenshots** moved to S59.2.3 (the brief's D-1). They need storage, upload, serving under the operator access log, and the export and deletion.

### Built (S59.2.2)
- db: migration 0069, the job scan, the saved-reply, rating and reminder repositories, the three public functions.
- contracts: the rating, solved-by, saved-reply schemas, `SUPPORT_QUIET_DAYS`, `SUPPORT_OVERDUE_HOURS`, `support_thread.rated`.
- core: `services/support-housekeeping.ts`, `rateSupportThread`, saved replies in `operator-support.ts`.
- worker: the `Support job`.
- api: `PUT /v1/support/threads/:id/rating`, `/v1/ops/replies`.
- web: `/ops/replies`, the reply picker, "Over 4 h: answer next" on the inbox, "Did this help?" and "Closed after 7 quiet days" on the thread.
- Tests: `support-housekeeping.int.test.ts` and `.test.ts` (core); `operator.int.test.ts` and `isolation.int.test.ts` (db); the controller tests; `jobs.module.test.ts`; `ops.test.ts`; `ops.spec.ts`, `support.spec.ts`; `screens.spec.ts` (`ops-replies-*`, `support-thread-solved-*`).

## Part 3 (S59.2.3, preapproved at its brief: screenshots)
1. **Upload in two steps (AC-X-27).** A member uploads each screenshot on its own (`POST /v1/support/screenshots`, raw body, as photos and imports do) and gets its id. The request or reply then carries up to 3 ids (`screenshotIds`). Only the uploader's own unsent screenshots can be attached, and each only once. The public form takes none: nobody signed in answers for them.
2. **Limits and cleaning (AC-X-28).** The `screenshot` kind of `processImage` (ADR-0048) judges the type by content: JPEG, PNG or WebP; HEIC refused; at most 10 MB and 40 MP; a short side of at least 16 px; at most 1:8. It is turned upright and re-encoded as WebP (quality 90, so text stays sharp) without metadata, at most 2560 px wide, with a 480 px thumbnail. A member may upload 20 a day, counted under the support writer's advisory lock. An upload not sent within 24 h is deleted by the support job (row and objects).
3. **Storage and serving (AC-X-29).** `support_screenshots` is a tenant table (`tenant_isolation`, a restrictive `member_scope`: the uploader's unsent ones, or a sent one whose thread the member may read). Objects live at `tenants/<t>/support/<id>/<width>.webp`. The API streams them to a reader (`nosniff`, `default-src 'none'`, `private, no-store`); there is no public or signed address. Not found and not allowed answer the same.
4. **The console (AC-X-30).** Operators read screenshots through `withOperator` with the action `screenshot.read`: one access-log row per image served, in the same transaction (the `operator_read` policy needs it). Opening the thread lists them without serving the bytes. The inbox counts each request's sent screenshots.
5. **Export and deletion (AC-X-31).** The export zip has `support/screenshots/<id>.webp` (the full width), named in `support.json` on its message. The business's deletion removes the objects through the worker's `beforeBusinessDeleted` hook, next to the photos; the rows go by cascade.
6. **A storage port (layer rules).** `packages/core` may import only contracts and db, so support's screenshots go through a `ScreenshotStorage` port defined in core (check and remake, put, get, delete). `createScreenshotStore(objectStore)` in `@pepper/storage` is its adapter; the api, the worker and the export wire it in, as the outbox's `Mailer` is wired.

### Built (S59.2.3)
- db: migration 0070, `repositories/support-screenshots.ts`, screenshot counts on threads and the inbox.
- storage: the `screenshot` kind, `screenshotObjectKey`, `createScreenshotStore`.
- core: `services/support-screenshots.ts` (the port, upload, attach, reads, sweep, deletion, export reads); attach in `openSupportThread`/`replyToSupportThread`; `readOperatorScreenshotImage`.
- api: `ScreenshotStoreModule`, `/v1/support/screenshots`, `/v1/ops/screenshots/:id`; worker: the sweep and the deletion hook; imports: images in the export.
- web: the screenshot picker, `MessageScreenshots`, the counts.
- Tests: `support-screenshots.int.test.ts` (db, core), `isolation.int.test.ts`, `screenshots.test.ts`/`images.test.ts` (storage), `screenshots.controller.test.ts`, `photos.int.test.ts`, `export.test.ts`, `jobs.module.test.ts`, `support.spec.ts`, `ops.spec.ts`, `screens.spec.ts`.

## Part 4 (S59.4, preapproved at its brief: the pilot metrics page)

- `/ops/metrics` (`GET /v1/ops/metrics?days=7|30`) reads in one `withOperator` transaction with the new action `metrics.read` (migration 0073 widens the access log's CHECK).
- The numbers outside support come from one definer function, `operator_pilot_metrics(since, until)`. It refuses (42501) without `current_operator_id()`, reads each business as itself (its tenant policies, with `tenant_id` named in every query because the owner may bypass RLS), restores the transaction's settings, and returns counts and medians only: no client, booking, member or business row reaches an operator. Businesses are found through 0072's owner read of `memberships`; sign-ups are global.
- Support's numbers (first-reply time, by email vs in the app) use the existing operator policies; inbound counts reuse `countInboundByOutcome` with the period's end.
- A cancellation's time is its `booking.updated` audit entry (else the row's last change); waitlist conversion counts answered offers. Rates and medians from fewer than 5 cases say "Not enough yet" (D-3).
- Later: the function loops over businesses (fine for the pilot's handful; one grouped query per table if hundreds). The AI and engagement metrics are S59.4.2.

### Part 4, addendum (S59.4.2: AI and engagement metrics, the change against the period before)

Decided at the brief (the user: "I'm leaving it up to you"; AC-X-50…53):
- A second definer function, `operator_ai_metrics(since, until)` (migration 0074), with the same guard, per-business reading and restored settings as `operator_pilot_metrics`; the definitions sit in its header. It uses inline CTEs only, never a temp table: a session's temp schema is shared with the caller, who could make a table of the same name and read back what the definer wrote.
- **Weekly active owners:** owner-weeks (whole weeks ending now, for owners whose membership began before the week) with 4 or more active days on the business's own calendar; a day is active with an audit entry the owner made (`actor_kind = 'user'`, not the AI's on their behalf) or a chat turn.
- **Cards vs chat:** a member's approval, decline or edit of a proposal, a feed card dismissed by itself (one closed by its proposal is not counted twice), or an undo, against chat turns.
- **Approval:** approved ÷ approved, declined and expired (superseded ones were replaced, not shown to the end). **Correction:** an edit (the member's own `ai_proposal.created`) or a decline followed within 10 minutes by a proposal for the same action asked by the same member, ÷ shown + edited. **Undo:** actions run in the period undone with the reason "wrong".
- **AI cost:** turns don't store their model, so the chat's tokens are priced at the strong model's rate (`PILOT_AI_PRICE_PER_MILLION_USD`, from `packages/ai/evals/prices.json`): an upper bound, said on the page. Background AI (drafts, import mapping) is metered monthly in `usage_meters` without the input/output split and is left out until turns or a ledger carry the model.
- **Rebook rate:** ADR-0039's interval (the service's `rebook_after_days`, else the client's median gap from 3 or more visits, 7–365 days); a visit counts when its interval ends in the period, rebooked when a later visit was booked by then (an imported one by taking place by then). Tracked: the "+10 points vs baseline" check reads the change against the period before until each owner's pre-Pepper baseline is computed from imported history (after the pilot starts).
- **The change** (top-up): core reads the same span just before under the same `metrics.read` row and keeps a metric's earlier number only when it had enough cases; `better`/`worse` follows each metric's direction (`PILOT_METRIC_TARGETS[...].better`), and for a range by how near it came. The kit's `Trend` shows ▲/▼ with the change and says it in words for screen readers.
- Tests: `ai-metrics.int.test.ts` (db), `pilot-metrics.test.ts` (contracts, core, web), `operator-support.int.test.ts`, `blocks.test.tsx`, `ops.spec.ts`, `screens.spec.ts`.
