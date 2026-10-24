# ADR-0040: Rebooking nudges with drafts, one-click unsubscribe, `get_feed` and the first guide batch

- **Status:** Accepted. Pre-approved by the user at the S36a brief on 2026-10-24 ("Go ahead, start with the recommendation and complete the tasks").
- **Date:** 2026-10-24
- **Builds on:**
  - ADR-0024 (outbox)
  - ADR-0025 (`Periodic` jobs)
  - ADR-0028 (trust layer)
  - ADR-0029 (tools)
  - ADR-0031 (cards, *Why?*)
  - ADR-0033 (models)
  - ADR-0039 (the feed)
  - [Phase 8 playbook](../plan/phase-8-playbook.md) §2, §3, §6 and D-3, D-9 to D-13
  - [PCR-006](../plan/changes/PCR-006.md)

## Context
S35 built the feed with rules only. S36 adds the first thing in Phase 8 the model writes: a rebooking email to a regular who is due back, offered under "Needs your OK" (AC-W4-1) and sent exactly once when approved (AC-W4-2).

The playbook fixes the boundaries:
- The model writes words only. The domain picks the recipient, the time and the link (D-3).
- Nudges ask first by default, at most 20 drafts a business a day (D-9).
- One-click unsubscribe (D-10).
- `get_feed` is a read tool, and approval stays on the cards (D-11).
- The four S33 leftovers ride this guide batch (D-12).

The brief settled four questions:
- **D-1:** when drafts are built, since AC-W4-1 says "when the daily briefing runs" and S38 builds the briefing.
- **D-2:** the postal address CAN-SPAM requires.
- **D-3:** who approves.
- **D-4:** this ADR.

## Decision
1. **A morning drafts pass (D-1 A).** It is a `Periodic` worker job (`DRAFTS_POLL_MS`, every minute). It runs once a day per business, at the template's `drafts.morningHour` in the business's time zone (7:00 by default).
   - `insight_runs.drafts_due_at` (migration 0045) holds the next morning. `claimDraftsRun` moves it with a conditional update, so of two workers only one drafts. The scan `listDueDraftRuns` reads ids only, under `job_scan('insights')`.
   - Before its hour, a business waits for it, its first day included.
   - Paused suggestions, `rebooking_due` turned off, or no mailing address: the pass claims the day and drafts nothing.
   - **Order of work:**
     1. It runs the business's insights first, so the feed is this morning's.
     2. It lists open `rebooking_due` items (`listDraftableRebookings`) whose client has an email address, has not opted out, and had no nudge proposal within their interval (pending, sent, refused or expired all count; a superseded one, which reached no one, does not: S36b). The list is most overdue first, at most `DRAFT_LIMITS.perBusinessPerDay` (20).
     3. It looks for a free time tomorrow for the last visit's service: with their usual staff member first, else anyone who offers it (`findAvailabilityIn`). No time means no draft.
   - S38's daily briefing will call this same pass.
2. **The draft writer (D-3).** One call to the routine model (`write_draft`, a forced tool call, so the answer is always a subject and a body), metered against the business's monthly budget with a reservation of `DRAFT_LIMITS.maxTokens` (1,500).
   - **What the model is given:** the business's name and the template's `drafts.voice`, the client's first name (labelled untrusted), the service, who usually looks after them, the last visit's date and the weeks since.
   - **What it is never given:** a contact, a remembered note, a time or a link.
   - **The words must pass `NudgeDraftSchema`:** a one-line subject; at most 120 words; no link or bare domain; no email address or phone number.
   - **What happens to bad words:** a model answer that breaks a rule is dropped (`refused`). The pass does not retry, and no proposal is made.
3. **`send_rebooking_nudge`, a system write tool.** It is listed in `SYSTEM_TOOLS`, never in `TOOLS`, so the model is never offered it. Approve, edit and undo find it like any other tool.
   - **Payload:** ids, the offered time, the last visit and the words.
   - **Each run re-checks:**
     - the words against the draft rules;
     - the client's own and the business's sensitive remembered values (`DraftRefusedError('sensitive')`);
     - the mailing address and the client's email address and opt-out (`NudgeNotSendableError`);
     - that the time is still free.
   - **The email it queues:** the domain appends the open time ("Jess has an opening on Tuesday, November 3 at 9:00 AM"), the booking page link, and a footer. The footer holds the business name, its mailing address and the unsubscribe link.
   - **Delivery:** the email goes through the outbox with the undo-send grace, dedupe key `nudge.rebooking:<client>:<start>`. That key, the proposal's idempotency and the outbox's claim make it one email per recipient, whatever retries (AC-W4-2).
   - **The fingerprint** covers the exact words, the client row's version, the address and the time. A changed world gives a fresh proposal; a taken time is refused with "booked meanwhile".
   - **Dial action and receipt:** the dial action is `message.rebooking_nudge`, and Undo takes the email back until it leaves. The receipt's *Why?* says when the last visit was, why the client is due and that the time was free.
4. **Proposals of the business (D-3).** The morning pass is not a member, so the trust layer gets `proposeForBusiness`.
   - **How it runs:** the tool's dry run runs as the business's AI acting for its owner. The proposal is stored with `requestedBy` and `recordOwner` both null and audited as `system`.
   - **Who decides:** only owners and managers may see or decide it. Staff see the suggestion until it is drafted, then neither the item nor the proposal.
   - **The dial:** whatever the dial says, a pass's action is a proposal. "Just do it" for nudges takes effect only for nudges a member asks for, which V1 does not have.
5. **Edits re-fingerprint.** `reviseProposal`, in the trust layer, takes a decider's new payload on the card whose fingerprint they saw. It runs the dry run again and replaces the proposal (same target, new fingerprint). An out-of-date card gets the current proposal back, and a past one expires.
   - `reviseNudgeDraft` is its only caller. It checks the words first, and only nudges can be edited this way.
   - The card (`DraftEditor`) approves the replacement, so edited words can't be sent unedited and unseen words can't be sent at all.
6. **Feed items follow their proposal.**
   - `linkFeedItemToProposal` sets an item to `needs_ok`. The insights pass leaves such items alone.
   - The trust layer then settles the item with its proposal (`settleFeedItemsOf`):
     - approved → `done`;
     - rejected → `dismissed`, snoozed 30 days;
     - expired or refused → `expired`, which the pass may open again.
   - A replacement (an edit, a fresh preview) takes the item along (`repointFeedItems`).
   - Home's "Needs your OK" stays the proposals list, so it has one source of truth (ADR-0039).
7. **One-click unsubscribe (D-10, RFC 8058).**
   - **The token:** an HMAC-signed link (`unsubscribeKeyFrom(outboxKey)`, 16-byte tag) names the business and the client. It is checked before anything is read; it is never stored and never expires.
   - **The routes:** `GET /v1/public/unsubscribe/:token` describes; `POST` unsubscribes. The POST is idempotent, sets `clients.email_opt_out_at` and writes the audit entry `client.email_opted_out`, without the address. It skips the Origin check, because a mail provider's POST has none and the secret is the authority. It is rate-limited per address.
   - **The emails:** nudges carry `List-Unsubscribe` and `List-Unsubscribe-Post` headers to the api route, and a footer link to `/unsubscribe/<token>`. That page needs no sign-in, and opening it changes nothing, because mail scanners open links.
   - **What it stops:** nudges only; booking emails still go.
8. **The mailing address (D-2 A).** It is stored in `tenants.mailing_address` (5–300 characters, at most 4 lines, no contact) and set by owners and managers with the feed's switches (`PATCH /v1/feed/settings`). It is shown on Home under Suggestions. Its audit entry records only whether an address is set, because it may be a home.
9. **`get_feed` (D-11).** A read tool over the member's open suggestions and the items waiting for an OK (`feedForAiIn`). It is scoped like the screens: staff see their own items only; nothing is returned while paused; kinds turned off are left out.
   - **What each item holds:** ids, numbers, local dates, the names a member sees (a client's cut to letters), and `waitingForOk`. Never a draft's words or a contact.
   - **The instructions say** the AI never approves, edits or sends what waits there. There is no tool to approve, and approval needs a person (ADR-0028).
10. **The guide batch (D-12):**
    - **Instructions v6:**
      - a client's request the member passes on with "book it" is proposed, not asked about again (`pasted-request-then-book`);
      - closures that stop bookings are rules;
      - the feed is read through `get_feed`.
    - **`list_services_and_staff` v3:** each staff member's weekly hours ("works") in local wall-clock time (`who-works-saturdays`).
    - **`find_availability` v3:** `notBefore` holds on every day of a range. There is one search per local day, so a clock-change day still means "after 3".
    - **`propose_rule` and `remember_fact` v2:** "we're closed Dec 24–26" is a rule, and only "note that…" is a fact (`lr-blackout`).
11. **Evals (playbook §5):**
    - **New sets:** `drafts` (gate 90%, pass^3 80%), `feed` (90%) and `feed_safety` (100%).
    - **The `juniper_feed` world:**
      - Sara and Sarah each had three haircuts four weeks apart and are a week overdue; Sarah has no email address.
      - The business has a mailing address.
      - Seeds can opt out a client, pause suggestions, remove the address, or rename a client.
    - **New eval actions:** `runInsights` and `morningDrafts`.
    - **New graders:**
      - the drafts (count, `mustMention`, `mustNotContain`, the draft rules, and what no draft-writer request may hold);
      - the rebooking emails queued;
      - the feed afterwards.
    - **Cases:** 30 new, each with scripted answers: 10 `drafts`, 7 `feed`, 8 `feed_safety` (the drafts part), and 5 new leftover cases. The existing `pasted-request-then-book` and `who-works-saturdays` got scripted answers too. Held-out cases replace the tuned `who-works-saturdays` (`marco-saturday-hours`, `afternoons-next-week`).
    - **Cost:** `PHASE_CAPS_USD[8] = 1.25`, and the run estimate counts a drafts pass.

## Results (S36a, scripted model)
- **Acceptance criteria:** AC-W4-1 and AC-W4-2 integration tests are green (`packages/ai/src/drafts/morning.int.test.ts`, 7 tests). They cover:
  - the morning hour, the metered call and what the model was sent;
  - owners and managers only;
  - the feed item waiting;
  - nothing queued until approval;
  - one email under a duplicated job;
  - the edit;
  - opted-out, no address and paused;
  - a sensitive value;
  - a time booked meanwhile.
- **Scripted evals:** every case with a scripted cassette passes, the new sets included.
- **Recorded cassettes:** all stale, as planned (instructions and tools changed). S36b records them once.

## Results (S36b, real model: `gpt-6-luna` low / `gpt-6.1-sol` low)
| Gate (playbook §2) | Result |
|---|---|
| `drafts` ≥ 90% pass^1, ≥ 80% pass^3 | 14/14 pass^1, 14/14 pass^3 |
| Draft safety and `feed_safety` 100% pass^3 | 8/8 pass^3 (drafts' safety graders 14/14 pass^3) |
| `feed` ≥ 90% pass^1 | 10/10 |
| S33 leftovers at pass^3, `KNOWN_REAL_MODEL_MISSES` empty | `who-works-saturdays`, `lr-blackout`, `pasted-request-then-book` 3/3; empty |
| No regression in Phase 6–7 sets (pass^1; pass^3 at S38b) | every set at or above its gate; scheduling 47/48 (held-out `is-marco-free-at-eleven`) |
| A draft ≤ 1,500 tokens | at most 506 |
| AC-W4-1 / AC-W4-2 | `morning.int.test.ts` 8/8 |

- **Guide changes from the recordings:** `get_feed` v3 (free time in a staff member's days, without asking for a service; to-dos go to `list_todos`; dismissing a suggestion happens on Home); `list_todos` v2 (what is still open or to do, for the member or the team); the instructions' "same as last time" is the last visit's service and staff member.
- **Graders corrected where the model was right:** `after-three-two-days` (one search per day is right too; the reply must cover both days with no time before 3) and `mr-staff-fact` ("doesn't usually work Saturdays").
- **Code review over both halves (S36b):**
  - A superseded nudge (refused at approval because the time was booked meanwhile) no longer blocks the next morning's draft.
  - The writer is told the usual staff member only when the time offered is theirs.
  - The client's first name reaches the writer and the card as letters only (`clientFirstName`).
  - A proposal that breaks for another reason than a refusal counts as `failed`, and the worker warns.
  - Trace spans never export an unsubscribe token.
  - One-click POSTs get a per-address limit of 600 in 10 minutes (the page keeps 30).
  - Two unsubscribes at once audit once.
  - The web explains the three new error codes.
- **Security review:** no findings.
- **Spend:** $0.6237 of Phase 8's $1.25 ([ai-budget.md](../plan/ai-budget.md)).

## Consequences
- **One email per client per interval, by construction:** a turned-down or expired nudge also keeps the client from being nudged again within their interval. A superseded one does not (it reached no one; its replacement counts on its own, S36b).
- **Clients without an email address** stay plain suggestions.
- **The worker needs more configuration:** OpenAI (routine model) and `AUTH_BASE_URL` (the web origin for links) to draft. Without either, drafts are off and the feed works as in S35.
- **What waits for later sessions:**
  - A screen to see or undo an opt-out, and opt-outs from other channels, wait for client messaging in Phase 9.
  - The waitlist offer (S37) will reuse the system-tool route and `proposeForBusiness`.
- **Playwright scope:**
  - Covered: the mailing address and an invalid unsubscribe link.
  - Not end to end: the nudge card. The e2e stack runs no model in the worker. The card is covered by UI unit tests, api route tests and the integration tests above.
