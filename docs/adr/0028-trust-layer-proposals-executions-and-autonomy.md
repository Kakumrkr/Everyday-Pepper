# ADR-0028: The trust layer: autonomy decisions, proposals, receipts and undo

- **Status:** Proposed (drafted by Claude in S23, 2026-10-21). The user chose, at the S23 Session Brief ("Go ahead with your recommendations"):
  - PCR-003 (`booking.cancel` and `task.create` on the dial, the strictest-action rule, the bulk lock by recipients);
  - a 2-minute "undo send" grace on AI-queued client emails;
  - the undo windows below;
  - an "Ask me first for everything" switch.

  The rest are Claude's defaults below.
- **Date:** 2026-10-21
- **Builds on:** ADR-0005 (the model proposes, the domain decides), ADR-0013 (permissions, audit), ADR-0017 (member scope), ADR-0024 (outbox), ADR-0027 (provider port), the [Phase 6 playbook](../plan/phase-6-playbook.md) principles 1, 2, 6–10.

## Context
Phase 6's differentiators D-1 (exact previews), D-2 (receipts with Why and Undo) and D-4 (team-aware) all rest on one layer. That layer decides whether the AI may act, holds what it proposed exactly as the member saw it, records what it did, and reverses it safely. The playbook assumes the model is compromised: safety must come from the domain.

S24 builds the tools and S25 the agent loop, so this session builds the layer they plug into, with a port the tools will implement. It proves the layer with fake tools that write real rows.

Market check (S22 desk research, re-checked at the S23 brief): no salon or wellness tool lets the AI act inside the business with per-action trust, exact previews and undo.

Guidance:
- OWASP's 2026 Top 10 for LLM Applications moves Excessive Agency up to LLM03.
- OpenAI's agent guidance pauses side effects for human approval.
- Current practice ties an approval to a fingerprint of the exact arguments.

This ADR goes further and also fingerprints the state the preview read.

## Decision
1. **`decideAutonomy`** (pure, `packages/core/src/autonomy.ts`).
   - **Input (`AutonomyRequestSchema`):** the dial actions a tool call involves, the tool's declared tier, the recipients its preview counted, and whether the turn read untrusted text (plus "changes autonomy"). None of it comes from the model's arguments.
   - **Output:** `execute` (quiet receipt), `execute_and_notify` ("done for you" card with Undo) or `propose`, plus a stable reason code (`read_only`, `setting`, `ask_first`, `bulk_lock`, `untrusted_context`, `autonomy_change`).
   - **Rules,** each of which can only make the outcome stricter:
     - changing autonomy always asks;
     - the tier is the strictest of the declared tier and the actions' tiers;
     - a read runs;
     - a write naming no dial action asks;
     - "Ask me first for everything" asks;
     - an external action to more than 10 recipients asks (AC-W7-3, whatever the action);
     - an external action after untrusted text asks;
     - otherwise the level is the strictest of the actions' levels;
     - after untrusted text, "just do it" becomes "do it and tell me".
   - **`resolveAutonomy`:** the business's level for each action, else its template's, else the platform default. A stored level the action doesn't allow fails closed to "ask".
2. **Autonomy settings** (`autonomy_settings`, one row per business or none): the switch and the overridden levels only.
   - Everyone in the business reads them. Only owners and managers change them, enforced both by the service and by RLS.
   - The AI never changes them (`changeAutonomy` refuses an AI actor).
   - Database checks hold the eleven known actions and three levels, and never allow "just do it" for `message.bulk`.
   - Audited as `autonomy.updated`.
3. **Proposals** (`ai_action_proposals`):
   - **Contents:** the exact payload, the domain's preview, the state fingerprint, the *Why?* trace, the member it was made for, the owner of the record it changes, and an expiry (24 h, never after the appointment starts).
   - **Lifecycle:** pending → approved / rejected / expired / superseded.
   - **One pending proposal per target:** a unique partial index; a newer request for the same thing supersedes the old one.
   - **A retried tool call** finds its proposal by idempotency key.
4. **The state fingerprint** (`stateFingerprint`): SHA-256, with a domain separator, over canonical JSON (sorted keys) of:
   - the tool and its version;
   - the payload;
   - the state the preview read (the touched rows' `updated_at`, the rules, the hours);
   - the would-be messages (template and recipient ids).

   **Approval** sends the proposal id together with the fingerprint the card showed. Inside the approval transaction, with the proposal locked, the trust layer re-runs the tool's preview. Any mismatch marks the proposal `superseded` and returns a fresh proposal to show. Nothing runs that the member did not see.
5. **Who decides** (approve, reject, undo):
   - only a person; an AI actor is refused, because an undo can cancel a booking and would get around the dial;
   - the member it was made for, or a member whose role reaches every record of the kind (owners and managers);
   - only if the approver's own role allows each action on the record now (`can()` with the record owner), re-checked at approval time.

   The domain service checks again when it runs, and RLS limits staff to their own proposals and receipts.
6. **Executions** (`ai_action_executions`): the receipt, written in the same transaction as the change. It holds:
   - the outcome and the idempotency key;
   - the entity and before/after;
   - the inverse with `undo_until`;
   - the *Why?* trace;
   - the outbox message ids;
   - the member the AI acted for.

   The trust layer checks every linked message: it must belong to this business, be pending, and (for a message action) wait the undo-send grace.
7. **Undo windows** (per action, in the contracts, fixed when the action runs):

   | Action | Undo window |
   |---|---|
   | Booking actions | 24 h, never after the appointment starts |
   | Blocked time | 24 h |
   | Notes, to-dos | 7 days |
   | Messages | Until they leave |

   AI-queued client emails wait `AI_EMAIL_GRACE_SECONDS` (120 s), so Undo truly unsends them.
8. **Undo runs in one transaction:**
   1. Lock the execution.
   2. Check the window and the permission.
   3. Take back the unsent messages (`cancelOutboxMessages`, new outbox status `cancelled`; a message a worker is delivering is reported "too late", never half-cancelled).
   4. Run the tool's inverse through the domain, as the member.
   5. Mark the execution undone with a reason (`wrong`, `changed_mind`, `other`: the wrong-action metric).

   If the inverse is refused (`UndoRefusedError`: slot taken, already started, changed since), or a message that was the whole action already left, nothing changes.
9. **The tool port** (`ActionRunner`, implemented by S24 tools):
   - `tool`, `version`, `actions`, `tier`;
   - `preview(tx, actor, payload)` → preview, fingerprint, recipients, record owner, target key, appointment start;
   - `execute(tx, actor, payload)` → effect with inverse and queued message ids;
   - `undo(tx, actor, receipt)`.

   They run inside the trust layer's transaction, through the same domain functions as the screens, and never commit or call the model. **S24 therefore gives the services it needs transaction-taking variants.**
10. **Entry points** (`packages/core/src/services/ai-actions.ts`):
    - `requestAction`: decides with the dial from the domain's own preview, so no caller can skip it; refuses what the member may not do at all (D-4);
    - `approveProposal`, `rejectProposal`, `undoAction`;
    - `listPendingProposals`, `listRecentActions`;
    - `getAutonomy`, `changeAutonomy`;
    - `expireProposals`, run by the daily clean-up.
11. **The AI in the audit log:**
    - a new actor kind `ai_on_behalf_of` with the member;
    - every service writes its actor through `auditActorOf(actor)`, so a tool only sets `Actor.via = 'ai'`;
    - new actions `autonomy.updated`, `ai_proposal.created`, `ai_proposal.decided`, `ai_action.executed`, `ai_action.undone`, each holding codes, statuses and times only.
12. **Ids only.**
    - Payloads, previews, before/after, inverses and explanations pass `TrustJsonSchema`: plain JSON, at most 8 KB (checked first), never a string that looks like an email address or phone number. This is a defence in depth behind each tool's strict schema.
    - Explanations refer to the member's message by id (S25) rather than copying their words.
    - Database checks repeat the formats and sizes.
    - Triggers refuse any change to a proposal's or receipt's content, a second decision, or a second undo. The services have no DELETE on either table; a deleted business takes them with it.

## Consequences
- **Gains:**
  - **Writes without approval when the dial says "ask": 0 by construction.** The decision is taken inside the trust layer from the domain's preview, and property tests prove it over every action × level × tier × context. Mutation-checked: removing the bulk lock or the untrusted demotion fails 37 / 43 cases.
  - A double tap, a retry, two approvers or two undoers at once act once (row locks, unique keys; tested concurrently on Postgres). An undo racing the worker either cancels the email or reports it sent, never both.
  - D-2's "Undo also cancels unsent emails" is real thanks to the grace. Competitors' email undo is cosmetic.
  - The hostile fake (S24) has fixed targets to attack: approving its own proposal, undoing to cancel, linking foreign messages, raising autonomy.
- **Costs and risks:**
  - S24 must refactor the booking services to accept a transaction.
  - The fingerprint is computed in the approver's scope. A lead approving a staff member's proposal may see more rows, which reads as stale once and then converges. Tools should fingerprint only the rows the action touches.
  - When a lead approves a staff member's proposal, the receipt belongs to the lead. The staff member doesn't see it in their own list (logged for S26).
  - A worker that sent an email and died before recording it leaves a pending message an undo can still "cancel". This is the outbox's existing at-least-once edge, and stays rare.
  - The ids-only guard is a heuristic: a phone number stored as a JSON number, or written in words, passes it. Tools' strict schemas are the real control.

## Alternatives considered
- **Autonomy as a JSON column on `tenants`:** fewer tables, but a wider write surface on a row the booking page reads. A separate row gets its own RLS write rule and audit.
- **Two-phase approval** (claim, execute in the service's own transaction, then record): no service refactor, but a crash between the steps leaves an execution without a receipt, or the reverse. Chosen instead: one transaction through transaction-taking services (S24).
- **The caller passes the decision in:** simpler, but the dial would then only be as safe as the agent loop. Deciding inside the trust layer means a compromised loop or model still can't skip it.
- **Fingerprinting the arguments only:** misses a booking that moved or a rule that changed after the preview, which is exactly the stale case that hurts.
- **A per-tool undo window chosen by the tool:** flexible, but the member would see inconsistent windows. Per action, in the contracts, is reviewable in one place.
