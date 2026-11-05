# ADR-0059: Post-visit review requests, drafted by the morning pass

- **Status:** Accepted. Pre-approved by the user at the S55.2 brief on 2026-11-05 ("Preapproved with your recommendation").
- **Date:** 2026-11-05
- **Builds on:** ADR-0028 (the trust layer), ADR-0040 (rebooking nudges: the footer, the opt-out, the morning pass), ADR-0055 (presets), ADR-0057 (domain-written words)

## Context
Review requests are a baseline feature in every booking tool the target owners use (V1 scope, Phase 12). They are marketing email, so they need what the rebooking nudge has: the owner's OK, the CAN-SPAM footer, the one-click unsubscribe, and a limit on how often a client is asked. S55 split them out of the proof-of-value session (ADR-0058, D-1).

## Decision
1. **A dial action of its own:** `message.review_request`, `external_or_irreversible`, ask by default, "just do it" allowed, Undo until the email leaves. Hands-off sets it to "do it and tell me", as for every client email (ADR-0055). Migration 0065 widens the three action checks.
2. **A system tool, `send_review_request` (never offered to the model).** It takes the client, the visit and the words. At every run (the proposal's dry run and the approval) it checks:
   - the words (the nudge's draft rules: no link, no contact, ≤ 120 words, no sensitive remembered value);
   - the business's mailing address and review link;
   - the client (not deleted, has an email, not unsubscribed);
   - the visit (this client's, confirmed or completed, over).

   It then queues one email (`review_request`, deduped by client and visit): the words, "Leave a review here:" and the link, then the nudge's footer. Owners and managers decide it; staff don't see it. The words can be edited on the card like a nudge's (`reviseNudgeDraft` takes either tool).
3. **Drafted by the morning pass the day after (D-2).** After the nudges, the pass takes each client's latest visit that started in the last 48 hours and is over. The visit must be kept and not imported. The 48 hours cover a missed morning; the 90 days stop a second request.
   - A business gets at most 20 a day, the earliest visit first.
   - The words come from the domain (`reviewWords`): no model call, and no client's name goes to a model.
   - The pass runs review requests even when the rebooking suggestions are turned off, but not while suggestions are paused or without the mailing address.
4. **The link is the switch (D-3).** `tenants.review_url`: a full `https` address (Google, Yelp or the business's own page), set beside the mailing address on More ("Emails to clients"). It is `null` until set, and no requests are drafted until then. "Stop asking for reviews" clears it. The audit records only whether it is set.
5. **One a client per 90 days (D-4).** A pending, sent, turned-down or expired request blocks the next one for 90 days. Only a superseded one (an edit's replacement) reached no one. This is the same rule as the nudge's interval (`target_key` `review:client:<id>`).
6. **The unsubscribe page names both:** "Stop rebooking offers and review requests from …". One opt-out stops every marketing email; confirmations and reminders still come.

## Consequences
- A visit is asked about the morning after, not an hour after it ends. Once SMS lands (Phase 14) a same-day text can come with its own timing rules; the email stays the fallback.
- A visit the owner never marks done still counts when it was confirmed and is over, as in the insights. A missed visit marked `no_show` before the OK is refused at the send.
- Pepper doesn't know whether the client left a review. Review tracking (a Google Business Profile integration) is after V1.
- One more pending card a morning per visit. The board ranks them with the unpriced suggestions (no dollars).
- No model call, no new feed kind, and no recorded cassette changes. The system tool is attacked by name in the hostile suite.
