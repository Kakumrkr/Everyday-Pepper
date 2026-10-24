# ADR-0039: The operator feed, rule-based insights and the insights pass

- **Status:** Accepted. Pre-approved by the user at the S35 brief on 2026-10-24 ("Go ahead with your recommendations, ADR is pre-approved").
- **Date:** 2026-10-24
- **Builds on:** ADR-0002 (RLS), ADR-0017 (member scope), ADR-0016 (availability engine), ADR-0018 (templates), ADR-0025 (`Periodic` jobs and `job_scan`), ADR-0026 (tasks), ADR-0028 (trust layer proposals). [Phase 8 playbook](../plan/phase-8-playbook.md) §3, §6, D-2, D-4, D-14–D-16; [PCR-006](../plan/changes/PCR-006.md).

## Context
Phase 8 makes Home the operator feed: "Needs your OK", "Suggestions" and "Done for you". S35 builds the Suggestions half without any model: rules find the work, and the model only writes drafts later (S36). The playbook fixes the principles:
- every item is work with a reason;
- items are idempotent by (business, kind, subject, day) and expire when their reason does;
- dismissing snoozes that kind for that subject for 30 days;
- staff see only their own gaps and regulars;
- the insights run is a `Periodic` pass, not a queue (D-4).

S35 had to decide the thresholds, the storage, how a booking change triggers a new run, and how the three sections come together.

## Decision
1. **Four pure providers** (`packages/modules/appointments/src/insights/`), like the availability engine: no clock and no database. `findInsights(snapshot, enabledKinds)` returns candidates. Every day boundary is the business's local midnight (`fromZoned`), so a DST day is 23 or 25 real hours, and "+ n days" means calendar days. The thresholds are named constants (D-2 at the brief):
   - **`schedule_gaps`:** per active staff member, per local day in the next 7 (today included), working hours minus time off, bookings with their buffers, and the past. Gaps of at least the template's `minGapMinutes` count. One item per staff member and day, which expires at the end of the last gap. Audience: that staff member.
   - **`rebooking_due`:** the client's last visit (completed, or confirmed and past; no-shows and cancellations don't count). The interval is the visit's service `rebook_after_days`. If that is not set, it is the client's median interval between visits, from at least 3 visits, rounded and kept within 7–365 days. With fewer visits, nothing. The client must have nothing booked ahead. The item exists from the due date until twice the interval. Audience: the last visit's staff member.
   - **`no_show_pattern`:** at least 2 no-shows in the last 180 days, and a confirmed booking in the next 7 days (the earliest is picked). The item expires when that booking starts. Audience: owners and managers only.
   - **`staff_overload`:** booked at least 90% of working time (net of time off) on at least 3 of the next 7 days. Audience: owners and managers only.
2. **`feed_items`** (migrations 0043–0044):
   - **What a row holds:** ids (staff member, client, booking, service, proposal) and a kind-specific payload of numbers and dates only, checked by the contracts on the way out. Never names or free text (LLM02).
   - **Dedupe:** `dedupe_key = kind:subject:day` is unique per business, and a check ties it to its columns.
   - **Status:** `suggestion` / `dismissed` / `done` / `expired` (`needs_ok` is kept for S36's drafts). `acted_at` is set exactly when an item closes. `snoozed_until` is set only on dismissed items.
   - **Policies:** `member_scope` on `audience_staff_id` (NULL means owners and managers only). Inserts and deletes are only for owners, managers and the worker. FORCE RLS.
   - **Foreign keys:** subject FKs cascade, so a deleted client takes their items with them. The proposal FK sets only its own column to NULL.
3. **`syncFeedItems`** is the only writer for the pass:
   - It leaves out candidates whose kind and subject are snoozed.
   - It upserts by key. It updates an open item, or opens again one that expired because its reason went away for a while. It never touches dismissed or done items.
   - It expires every open item of the pass's kinds whose key it did not see, or whose time has passed.
   - A second run with the same data writes nothing.
4. **The insights pass is a `Periodic` worker job, not a queue** (D-4). Every `INSIGHTS_POLL_MS` (60 s by default), `runDueInsights` scans `insight_runs` (`job_scan('insights')`, ids and numbers only) for businesses that:
   - were never run;
   - were asked for since their last run;
   - or were last run an hour ago.

   Each business runs under its own tenant. A queue would add Redis state for work that is "recompute this business": idempotent and coalescing (ten booking changes in a minute are one run). One row per business is all the state it needs, and a restart loses nothing. BullMQ stays for the waitlist's per-offer timers (S37).
5. **Re-runs after changes count, they don't compare times:**
   - Every booking write (team and booking page, 7 sites), working-hours change and time-off change calls `requestInsights(tx)` in its own transaction. This adds 1 to `insight_runs.request_count`.
   - A run first takes a per-business advisory lock (`pg_try_advisory_xact_lock`; a second worker skips the business). It then reads the count before reading anything else, and at the end records it as `run_count`.
   - A change committed during a run leaves `request_count > run_count`, so the business is due again on the next pass. Booking writes never wait on a run.

   The first version compared timestamps. Its own test caught a lost request: a booking in the same millisecond as a run, which also stands for one that commits while a run is going.
6. **The business's switches** live in `tenants.feed_settings`:
   - `suggestionsPaused` (D-16): the pass skips the business and the feed hides its suggestions. Proposals stay.
   - `disabledKinds`: over the template's `insights.enabled`.
   - `answeredKinds`: the once-only "turn this off?" question.

   Owners and managers change them (`settings.manage`), with an audit entry `feed.settings_updated`. The question appears for owners and managers when one kind was dismissed 3 times in 14 days.
7. **The api and Home:**
   - `GET /v1/feed` returns suggestions with the names the member may see (joined at read time, under RLS), the switches, whether they may change them, and the question. It needs the new permission `feed.read` (everyone; staff their own).
   - `POST /v1/feed/:id/close` takes `dismissed` or `done`; following a suggestion's action records `done`. `PATCH /v1/feed/settings` changes the switches.
   - "Needs your OK" and "Done for you" stay the trust layer's `/v1/ai/proposals` and `/v1/ai/actions`, so each has one source of truth. Home shows the three sections in the mock-up's order, each with an empty state that says what will appear.
   - The sentences are written by code (`feedLine` in `@pepper/ui`) from ids, numbers and names.
8. **Templates and layers:**
   - `templateInsights(id)` (and `PLATFORM_INSIGHTS` without a template) gives the enabled kinds and `minGapMinutes`. `staff_overload` is on in all eight templates.
   - The worker passes the template's settings in, so L2 never imports L3. The worker may now import `@pepper/templates`, as the api does (dependency-map row 30 already had feed → templates).
   - `services.rebook_after_days` (7–365, nullable) holds the service's interval. Phase 9 onboarding fills it from the catalog; until then, regulars rely on their own median.

## Results (S35)
- **Insight fixtures:** 28 cases, all passing. They cover New York with both 2026 DST days, Phoenix, and Kolkata (UTC+5:30), with every expected instant written in UTC.
- **Insights pass:** p50 267 ms, **p95 328 ms** on one business with 15,918 bookings over a year, 2,000 clients and 6 staff (gate ≤ 2 s).
- **Feed:** **p95 17 ms** with 150 open items (gate ≤ 300 ms).
- **Isolation suite:** 100%, including `feed_items`, `insight_runs` and the `insights` scan.

## Consequences
- The feed is cheap and explainable: no model call. S36 adds drafts to items through the trust layer (`action_proposal_id`, status `needs_ok`).
- **Dismiss is broad by design:** dismissing one of Jess's gap days snoozes gap suggestions for Jess for 30 days, and her other open gap items expire on the next run.
- **Acted-on rates** are counted per kind and outcome (`feedOutcomeCounts`) for the §2 gate; a screen for them is out of scope (§8).
- **Changes outside the hooks** (a new staff member, a service's interval) show within the hour, not the minute.
