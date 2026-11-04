# ADR-0055: Trust controls (presets, standing rules, client-visible moves ask, earned trust)

- **Status:** Accepted (built in S53). Approved by the user at the S53 brief on 2026-11-04 ("pre-approved with your recommendation. Complete the session successfully"; D-1 no split, D-2 the eval business keeps moves on "do it and tell me" until S56, D-3 standing rules read back as sentences, D-4 this ADR, D-5 no migration).
- **Date:** 2026-11-04
- **Builds on:** ADR-0028 (the trust layer and the dial), ADR-0031 (the Autonomy page, cards, Undo), ADR-0043 (cards first; standing rules), ADR-0016 (booking rules); [scorecard](../plan/scorecard.md) C5, C8; AC-W7-5…9

## Context
Thirteen radio groups make the dial complete, but owners don't think in 13 settings. They want to say how careful Pepper should be, read the rules it follows, and not be surprised when a client gets an email. Trust should also be earned: once Pepper has done one kind of action many times without a mistake, it should offer to take more on, not wait to be asked. And a move emails the client, so a move that runs before the owner agreed is the surprise to remove first.

## Decision
1. **Presets are levels, not a stored mode.** `AutonomyPresetSchema` (`careful`, `balanced`, `hands_off`) and `presetLevels` (contracts) expand a preset into a level for every action, each one allowed for that action:
   - Careful asks for everything.
   - Balanced is the business's defaults (its template's, else the platform's). It is saved as "no own levels", so a later change to the defaults reaches it.
   - Hands-off does every change inside Pepper alone, sends confirmations alone, and sends nudges and waitlist offers and tells the member. A message to more than 10 clients, and a new booking rule, still ask.

   `PUT /v1/autonomy` takes `{ preset }`, never together with `levels`. A preset also turns "Ask me first for everything" off, so the page never shows a preset the switch overrides. It goes through the same `changeAutonomy`, so the same audit entry and the same owner-and-manager permission apply. `GET`/`PUT` answer with `AutonomyView`: the dial plus `preset`, the preset the effective levels match against the business's own defaults (`null`: your own mix). No migration: the stored levels are the truth, and the preset is read from them.
2. **Standing rules are read back, not typed.** "Your standing rules" (`standingRules` in `@pepper/ui`) is sentences built from the dial and the business-wide booking rules (`GET /v1/rules`, for members who may read them), each saying where it is changed. A rule typed in words and turned into settings by the model is an AI change, so it belongs with S56's recording.
3. **Client-visible moves ask.** `booking.move`'s platform default is now "ask" (it was "do it and tell me"). A business that chose a level keeps it. The card names who gets the email: the proposal view carries `recipients` (each emailed client's address, read live through `clientEmailAddresses` under the member's scope; a deleted client, a client without an address, or one the viewer can't see is left out), and the card reads "Emails Maria L. (maria@…) the new time." A receipt names the client only: the address on the client now may not be the one the email went to.
   - **The eval business pins `booking.move: notify`** (`EVAL_WORLD_AUTONOMY`, D-2). The 11 recorded real-model cassettes with moves were recorded under "do it and tell me"; a proposal there would make them stale, and recording belongs to S56b's budget. The model's prompt doesn't carry the levels, so the pin changes only the world's settings, not what the model is asked. S56a adds eval cases for a move that asks and removes the pin.
4. **Earned trust from the receipts.** `actionTrackRecord` (db) counts, per action, the executions of the last 30 days and the run of executions in the last 90 days since the action's last mistake: an execution later undone as "wrong", or a proposal turned down. Only times the database stamps (`created_at`) are compared, so a skewed domain clock can't reset or keep a run. It reads the trust tables under the member's scope, so staff count what was done for them. `getTrackRecord` (core, `GET /v1/autonomy/track-record`) adds `offer`: after `EARNED_TRUST_STREAK` (20) correct in a row, `earnedTrustOffer` names one step more room ("ask" → "notify" → "auto") where the action allows it. The offer goes only to members who change autonomy, and never while "Ask me first for everything" is on. Accepting it is an ordinary level change.

## Consequences
- An offer the owner doesn't take keeps showing on that row while the run holds. A stored "Not now" is for later, as are offers on Home.
- A move that asks adds one tap for owners who were happy before. The Balanced preset says so, and earned trust brings the step back once moves have been right 20 times.
- Executions record the tool's first action only, so a move with its email counts as a move. That matches what the owner approved.
- Not built: rules typed in words; a "Not now" for offers; a preset step in onboarding.
