# ADR-0026: Tasks (to-dos) and Web Push notifications for the team

- **Status:** Proposed by Claude (S21, 2026-10-20), on the four choices the user made at the S21 Session Brief: the `web-push` library rather than hand-written crypto; pushes for booking-page activity and due to-dos; no client names in a push; staff see and manage their own to-dos while owners and managers see all. The rest are Claude's defaults below, to be confirmed in review. · **Date:** 2026-10-20 · Builds on ADR-0013 (roles), ADR-0017 (member scope), ADR-0023 (service worker), ADR-0024 (outbox), ADR-0025 (job scans)

## Context
Phase 5 (messaging and jobs) lists **tasks** next to the outbox, email and reminders, and v1-scope promises **push notifications for owners and staff** in the installed app. The product brief describes "owner to-dos ('remind me Monday to order color') as tasks with due dates". The user also chose that a push, which shows on lock screens and passes (encrypted) through Google's or Apple's push service, never names a client.

## Decision
1. **Tasks** (`tasks`, core: `packages/core/src/services/tasks.ts`, `/v1/tasks`).
   - Fields: title (1–200 characters), optional due time, optional assignee (a member of the business), status `open`/`done` with `completed_at`, source `manual`/`ai`/`system` (the AI's tasks come in Phase 6), creator, and `due_notified_at`.
   - **Who:** permissions `tasks.read` and `tasks.manage`, scope `own` for staff. Staff reach the tasks assigned to them or that they created. This is enforced in the service and again by a restrictive `member_scope` policy. Staff give tasks only to themselves. Owners and managers see every task and may assign any member, or no one (a "team" task).
   - **Defaults:** a new task is the caller's own. A due date without a time is due at 9:00 AM on the business's clock, shown in its time zone like bookings.
   - **When a member leaves,** their tasks stay with the business, unassigned: a composite key to `memberships` with `ON DELETE SET NULL (assignee_user_id)` (Postgres 15+). An assignee must be a member (422 `task_assignee_not_member`).
   - **Audit:** `task.created` and `task.updated` record status, due time, assignee and source, **never the title** (free text). A change that changes nothing writes nothing.
   - **Screen:** a "To-dos" card on Home: add (title, date, time, and "For" for owners and managers), mark done, undo, overdue in the warning color.
2. **Web Push.**
   - **Devices** (`push_subscriptions`): a member turns notifications on per device and business, saving the browser's subscription (endpoint and keys).
     - Each member reaches only their own devices (`member_scope`: `current_user_id() IS NULL OR user_id = current_user_id()`); work without a user (the worker, the booking page) reaches all.
     - A device is removed with its membership.
     - A shared device moves to whoever turned it on last: that save runs without a user, for the authenticated member.
     - Each member keeps at most **10 devices** (the newest).
   - **Endpoints** must be on a browser push service: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.notify.windows.com`, https, no port or credentials. This is checked when a device is saved and again in the worker, because the worker sends to the endpoint (S21 security review).
   - **Through the outbox:** a push is an outbox message of type `push` (one per device) holding the device id, a title, one line, an app path and a tag. It is sealed like an email and queued in the change's transaction, deduped per change and device (`<event>:<id>:<time>:<device>`).
   - **Delivery:** the worker's `WebPusher` uses `web-push` 3.6.7 (pinned, worker only) to build the request: payload encrypted to the device (RFC 8291, `aes128gcm`) and a VAPID JWT. It sends it with `fetch` (TTL one day, 10 s timeout, no redirects).
   - **Failures:**
     - 404 or 410 from the push service: the device is gone. Its row is removed and the push is **dropped**: marked `dead` with `PushSubscriptionGone`, no alert.
     - A device turned off meanwhile is dropped the same way.
     - 408, 429 and 5xx retry like email. Other 4xx give up (alerted).
   - **What triggers a push:**
     - **The booking page:** a client books, moves or cancels. The booked staff member's login and the owners and managers get "New booking / Booking moved / Booking cancelled: *Haircut with Jess, Tue, Nov 3, 10:00 AM*", opening that day's calendar.
     - **A to-do coming due:** its assignee, or the owners and managers for a team task, gets "To-do due: *title*", opening Home. The due-task job runs on the reminders' interval (`REMINDER_POLL_MS`, 60 s) through a read-only `job_scan` policy named `tasks`. It handles each task under a row lock and once per due time; a new due time notifies again.
     - Team-made bookings push nothing: the team made them.
   - **The service worker** (`public/sw.js`) shows a push (title, line, tag, icon). A tap opens its page in an open window of the app or a new one, and only ever a page of this origin: a full URL, `//host` or `/\host` opens Home.
   - **The switch** ("Notifications on this device" on Home):
     - Turn on asks for permission, subscribes with the public key and saves the device.
     - Turn off removes this business's device but keeps the browser subscription, because one subscription serves every business on the device.
     - Other states: blocked, unsupported, and "add to your Home Screen first" on iPhone and iPad (iOS shows pushes only for installed apps).
     - The card is hidden when the deployment sends no pushes.
   - **Configuration:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
     - The api reads only the public key: `GET /v1/push/key`, and it means pushes are on. Without it the api queues no pushes and `PUT /v1/push/subscription` answers 503 `push_unavailable`.
     - The worker needs both keys to send. Without them it sends no pushes and skips the due-task job.
     - Compose and `.env.example` carry a **local-only** key pair. It is public, so a real deployment must set its own.

## Consequences
- Phase 5's deliverables are complete: outbox, worker, email, confirmations and reminders, tasks, and push.
- **AC-W4-2** (one email per change under retries) holds for pushes too: the same claim, lease and dedupe.
- Testing:
  - Real push services cannot be reached in tests. `WebPusher` is proven by decrypting its request as a device would and verifying its VAPID signature.
  - Delivery, gone devices and retries are proven against Postgres with a fake pusher.
  - Playwright checks the switch with a stand-in browser subscription.
- The browser subscription's endpoint is a capability, stored as given. Sending to it still needs the VAPID private key, which only the worker has.
- A task title the member typed appears on the assignee's lock screen. That is the member's own words; the screen does not ask for client details.
- A push is not sent when the worker lacks the keys the api has. The pushes then give up with an alert, which is the misconfiguration signal.

## Alternatives considered
- **Hand-written VAPID and RFC 8291 encryption:** no dependency, but about 150 lines of security-sensitive code to maintain. The user chose the library.
- **Push for every booking change, team-made too:** noisy, since staff make most of those themselves.
- **Client first names in pushes:** more useful, but personal data on lock screens and in push services. Declined.
- **Sending to any https endpoint:** simplest, but it lets any member make the worker call arbitrary URLs (SSRF).
- **Tasks in the appointments module:** tasks are not about appointments; the architecture puts tasks in the platform core (L1).
