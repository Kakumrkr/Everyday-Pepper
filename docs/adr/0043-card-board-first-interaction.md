# ADR-0043: Cards first, chat second: the Home card board

- **Status:** Accepted. Approved by the user in planning session P1 on 2026-10-26 ("Yeah, let's go with your recommendations").
- **Date:** 2026-10-26
- **Builds on:**
  - ADR-0028 (trust layer: dial, proposals, undo)
  - ADR-0031 (cards, Why?, Undo)
  - ADR-0039 and ADR-0040 (the feed and suggestions with drafts)
  - ADR-0042 (the daily briefing)
  - [V1 playbook](../plan/v1-playbook.md) P1-4, Phase 12; [PCR-007](../plan/changes/PCR-007.md)

## Context
The vision put "talk instead of click" first: owners run the business by chatting with the AI. The launch-readiness review (2026-10-25) named this the most dangerous assumption, because no owner had been asked. Five simulated owner interviews (role-played, hypotheses only) all pointed the other way. Three of five chose "show me cards I tap" and one chose "handle it and tell me after". Only a shop manager walking the floor chose to talk, and nobody asked for a chatbot. Owners do admin on a phone, in 90-second gaps, one-thumbed.

Pepper already has the pieces for a tap-first product: typed cards with approve, edit and undo, the autonomy dial, the feed (Needs your OK / Suggestions / Done) and the morning briefing.

## Decision
1. **Home is a daily card board.** The briefing sits on top. Below it come cards that need a decision, ranked by dollars at stake (from service prices). Similar cards are grouped ("Randy is open all week. Tell your regulars?"). The board stays quiet until the business has booking history.
2. **Standing rules make cards disappear.** Owners set rules once ("fill cancellations from the waitlist automatically, up to 4 offers"), as presets (Careful, Balanced, Hands-off) or in plain-language rules. These map onto the existing dial and booking rules, with no second permission system.
3. **Everything Pepper does is in a plain-language activity log**, read from the audit log and executions. It shows what was done, to whom, what was sent, and offers Undo.
4. **Chat stays, as an optional extra.** It is still the way to ask for anything; every card is still reachable from chat. It is not the centre of the product and not the main navigation.
5. **Trust grows from evidence.** After 20 correct actions of one kind, Pepper offers to do that kind alone. It is an offer the owner accepts, never an automatic change.

## Consequences
- The vision's first pillar and UX principle 2 change from "conversation first" to "cards first, chat available" (`vision-and-differentiation.md`, `ux-principles.md`).
- Phase 12 builds this. Phase 9's design work designs the board first.
- The pilot measures cards versus chat ([scorecard.md](../plan/scorecard.md) §3). If owners chat more than they tap, this ADR is revisited.
- Approve by text (Phase 14) is the same card, delivered over SMS.

## Alternatives considered
- **Keep chat first:** no change cost, but it bets the product on an untested habit. The cards already exist, so tap-first costs little.
- **Hands-off by default:** what one owner wanted. It risks a wrong message to a client before trust exists. Presets give that owner Hands-off in one tap.
