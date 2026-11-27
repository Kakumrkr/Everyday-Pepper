# ADR-0071: Visit risk is a band from named rules over booking behaviour

- **Status:** Accepted. Approved by the user at the S77 brief on 2026-11-27 ("Go ahead, start with your recommendations and complete the session successfully"): D-1 `bookings.cancelled_at`, backfilled from the audit log; D-2 the brief's points and bands; D-3 the evening wrap lists tomorrow's high-band visits; D-4 the wrap only this session, the fact ready for S78.
- **Date:** 2026-11-27
- **Builds on:** ADR-0039 (the insight providers and the insights pass), ADR-0058 (proof of value, the evening wrap), ADR-0068 §6 (booking page deposits and cards), ADR-0065 (the client's "C" confirm), ADR-0017 (member scope), ADR-0010 (RLS, forced). Rules for Phase 18: [PCR-017](../plan/changes/PCR-017.md), [V1 playbook](../plan/v1-playbook.md) §5.

## Context
A lost slot is the owner-operator's biggest daily loss. Before S77 Pepper only knew one thing about it: a client with two no-shows in six months (`no_show_pattern`). S78 (confirm or release) needs a reason to ask a client to confirm early, and the evening wrap should say why a visit is at risk, not just that it is. There is no data yet for a learned model (S86 waits for the pilot: about 500 finished visits and 30 misses a shop), and Phase 18's rules are that the domain decides, from booking behaviour only, and that nothing is trained on a shop's data.

## Decision
1. **Pure rules, no model.** `findVisitRisks` (`appointments/src/insights/visit-risk.ts`) takes a business's bookings, the instant and its cancellation notice, and returns every confirmed visit in the next `VISIT_RISK_HORIZON_DAYS` (14) with a band, points and reasons. No clock, no database, like the other providers.
2. **Five signals, named points** (`VISIT_RISK_SIGNALS` in `@pepper/contracts`, `VISIT_RISK_POINTS` and `VISIT_RISK_RULES`):
   - `missed_before`: the client's misses (no-shows and late cancels) over their finished or missed visits, pulled toward the shop's rate as if they had 5 more visits: 2 points from 0.15, 3 from 0.30. The shop's rate is its own once it has 20 such visits, else 0.10. Only scored when the client has missed at least once.
   - `first_visit` (1): no finished or missed visit yet; only the client's earliest upcoming visit.
   - `booked_far_ahead` (1): booked 14 days or more before it. Not for an imported visit, whose booking date is the import's.
   - `online_no_deposit` (1): booked on the booking page with no deposit or card taken (a `booking_payments` row).
   - `not_confirmed` (1): the client hasn't confirmed ("C", S62) within 48 hours of the visit.
   Bands: low 0–1, medium 2–3, high 4 and more. Reasons are kept most points first; a reason holds counts and days only, never text.
3. **Behaviour only.** The rules read a booking's id, client id, start, status, source, booking time, the client's confirm, the cancel time and whether it was secured. A test wraps the bookings in a proxy and fails on any other field read; the contract's reasons are strict objects.
4. **A late cancel needs its time: `bookings.cancelled_at` (migration 0089).** `setBookingStatus` takes the domain clock's instant: a cancel records it (keeping the first one), any other status clears it, and a check keeps the column and the status in step. Older cancels were backfilled from their `booking.updated` audit entry, else `updated_at` (the same rule as the pilot metrics, migration 0073). A cancel is late when it came inside the business's notice (`deposit_refund_hours`, the one notice the policy builder sets, S67.2).
5. **Stored for owners and managers: `visit_risks`.** One row per scored visit (band, points, reasons, when computed), with `tenant_isolation` and a restrictive `member_scope` of `current_member_sees_all()` only, so staff read none, not even of their own visits. The insights pass syncs it on every run: an upsert that changes a row only when its band, points or reasons changed (a second run writes nothing) and a delete of every other row. It runs even while suggestions are paused: risk is a reading of the book, not a suggestion. A client's "C" asks for a run. Rows go with their booking (cascade) and with the business.
6. **In the export and on the privacy page.** `visit-risk.json` holds each row; `appointments.json` gains each visit's `cancelledAt`. The privacy page says what the rating reads, that it follows fixed rules and that only owners and managers see it.
7. **The evening wrap uses the same rules.** `buildEveningWrap` scores the book on read (the wrap is read in the evening only) and names tomorrow's high-band visits with their top reason ("11:00 am · missed 2 of 5 visits"). It no longer uses the no-show pattern; the `no_show_pattern` feed card is unchanged.
8. **A `visit_risk` fact for *Why?*.** Facts hold flat values, so `visitRiskFactValue` flattens a risk (the band, then one key per reason) and `visitRiskFromFact` reads it back; the screens word it "I rated the risk of a missed visit high: missed 2 of 5 visits, not confirmed yet." S78's confirm-or-release card records it.

## Consequences
- S78 reads `visit_risks` to choose whom to ask early; S86 can replace the points where a per-shop learned model wins on the shop's own data, with the same signals and output.
- Changing a constant changes bands for every business at the next run; the fixtures in `visit-risk.test.ts` pin the rules' intent.
- The hourly pass means "not confirmed" and the 14-day window move at most an hour late; a booking change or a "C" asks for a run sooner.
- Old cancels without an audit entry are timed by `updated_at`, which may be later than the real cancel: such a cancel can read as late when it wasn't. New cancels are exact.
- No chat tool, prompt or instruction changed, so no recording was needed.
