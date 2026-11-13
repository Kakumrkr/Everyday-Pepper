# ADR-0066: Approve by text: a code per text, from the member's checked number, once

- **Status:** Accepted. Approved by the user at the S63 brief on 2026-11-13 ("Go ahead with your recommendations and complete the session"): D-1 the screens in S63.2; D-2 "Y" and a 4-digit code per text; D-3 waitlist offers first; D-4 the number on the account, the switch per business; D-5 this ADR.
- **Date:** 2026-11-13
- **Builds on:** ADR-0065 (the SMS channel, consent, quiet hours, the signed webhook), ADR-0031 (proposals approved by fingerprint), ADR-0041 (the smart waitlist), ADR-0010/0015 (RLS, definer functions)

## Context
Most cards wait for one tap, and the waitlist offer waits on the clock: a freed 2 pm is worth most in its first minutes. An owner with a client in the chair reads a text, not the app. A reply to Pepper's one number carries no session, so whoever can make a text appear to come from the owner's number could approve: caller ID on SMS is not proof, Twilio's signature only proves the request came through Twilio. A reply must therefore approve only the card it answers, only once, only soon, and only from the number the member proved they hold.

## Decision
1. **The member's number is checked first.** `users.phone` and `phone_verified_at` belong to the account (one person, every business they work in). `POST /v1/me/phone` texts a 6-digit code: urgent, `requested` (the one text the person just asked for, so no standing consent is needed; a STOP still drops it), its HMAC-SHA256 under a key derived from the outbox key and bound to the number, 10 minutes, 5 tries, a new request replacing the last, 5 requests an hour. `POST /v1/me/phone/verify` with the right code sets the number; a changed number clears every business's "Text me cards" and revokes their consents.
2. **"Text me cards" is consent, per business.** `memberships.card_texts`; owners and managers only (`settings.manage` is not needed: it is their own phone); turning it on records `member_settings` consent with the words as shown (`sms-consent-v2`). A number's consent is now unique per business **and source**, so an owner who also books as a client keeps both, and stopping a client's texts never stops the owner's cards (and the reverse).
3. **One text, one code, one card.** When a waitlist offer becomes a proposal (`ask` on the dial), the matcher calls core's `queueApprovalTexts` in the same transaction: for each owner or manager with the switch on, a verified number and consent in force, one text whose words name the time, the staff member and the clients' **first names only**. `approval_texts` keeps the outbox message id, proposal, member, number, the proposal's fingerprint at that moment, the code's HMAC (bound to the number), the expiry (the card's, or 2 hours after the text can go if sooner) and `used_at`. A 4-digit code is drawn until no other unexpired code for that number matches. No text is queued for a card that would expire within 15 minutes of when the quiet hours let it go.
4. **The reply is checked as a sign-in would be.** "Y 4821" (`classifySmsReply` → `approve`, after every keyword: "YES" stays START) reaches the api's `SmsApprovalService`:
   1. a number with 5 misses in the hour gets the miss answer without a lookup (Redis, per number hash);
   2. `sms_approval_target(phone, code_hash, at)`, a definer function, answers ids only for a matching text to **that number** that is unexpired or used in the last day; none is a miss;
   3. in that business's transaction, the row is locked: already used → "already done"; expired → "expired"; the member's verified number must still be this one, and the membership an owner or manager with a second factor (`decideTenantAccess`) and the switch on, else a miss; then `used_at` is set and committed **before** approving, so a code is spent once tried;
   4. the approval is the app's own (`AiActionsService.approve` → `approveToolProposal` → `approveProposal`) as that member with the stored fingerprint: a changed card is superseded and not run, a refused or handled one says so.
   A miss always gets the same words, so a reply never reveals whether a code exists. The webhook's Twilio signature check (ADR-0065 §5) still comes first.
5. **A sandbox text path for tests** (top-up). With `SMS_PROVIDER=sandbox` where the scripted model may run (CI, or local outside production), `POST /v1/dev/sms/inbound` runs the same inbound service as Twilio's webhook and answers its reply as JSON, and `GET /v1/dev/sms/sent?to=` lists the latest texts the worker's sandbox sent to a number (kept in Redis for a day, 100 at most). Anywhere else both are 404.

## Consequences
- A spoofed reply needs the member's number, a code sent only to that number, a live card, and fewer than 5 misses an hour: about 1 in 2,000 an hour at worst, for one waitlist offer (emails to clients, undoable). Higher-risk cards (payments, S68) do not get texts without a new decision.
- A card decided in the app before its text goes still gets the text; its "Y" answers "already handled". Cancelling the text with the decision is left for later.
- The code lives only in the text and its hash; numbers are never logged.

## Built in S63
- Migration 0078: `user_phones` (the account's checked number, a code's HMAC, 5 tries), `memberships.card_texts`, `approval_texts` (one row a text: the card, the member, the number, the fingerprint shown, the code's HMAC, its expiry, when used; tenant RLS, forced), consents unique per source, and the definer `sms_approval_target` (ids only).
- core `member-texts.ts` (`/v1/me/phone`, `/v1/me/phone/verify`, `GET/PATCH /v1/me/texts`; the code's text is `requested`: no standing consent, a STOP still drops it) and `approval-texts.ts` (`queueApprovalTexts`, `claimApprovalText`); ai `waitlistOfferSummary`; the matcher texts an offer waiting for an OK when the deployment sends texts, in a savepoint so a text never costs the offer.
- api `SmsInboundService` behind both Twilio's webhook and the sandbox's `/v1/dev/sms` (§5): keywords, then "C", then "Y" and a code; one answer for every miss, 5 misses an hour per number (an HMAC of it in Redis), a bare "Y" answered only on a member's checked number, a failed approval answered as not done (the code is spent first). Card texts need a second factor, as a session would.
- Tests: db (isolation incl.), core, ai matcher, api unit and `sms-approval.int.test.ts` (the whole path through the sandbox), runtime `SandboxTextLog`.

## Not done
- S63.2: the number and "Text me cards" on More → Texts and reminders, the approve-by-text journey, the "Confirmed by text" journey and screenshot.
- "N" to skip, other card kinds, cancelling a text once its card is decided.
