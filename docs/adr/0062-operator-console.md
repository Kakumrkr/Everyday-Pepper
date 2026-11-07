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
