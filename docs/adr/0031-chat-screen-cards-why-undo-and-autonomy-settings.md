# ADR-0031: The chat screen, cards, Why, Undo and the Autonomy settings

- **Status:** Accepted (user, 2026-10-21: pre-approved at the S26 Session Brief, "Go ahead with your recommendations, draft PCR-004, ADR is pre-approved … I'm pre-approving the PCR and ADR"; drafted by Claude in S26). The user chose, at that brief:
  - migration 0036 (a proposal's tool version; a receipt's requester and summary), recorded here as an amendment to ADR-0028 **without a separate PCR**;
  - staff may undo what a lead approved for them, while their own role allows it;
  - jsdom, Testing Library and axe-core as dev-only test dependencies of `@pepper/ui`;
  - owners and managers change autonomy (ADR-0028 wins over the prototype's copy, which is corrected);
  - the api's 200 ms Redis polling for chat events and cancel stays; blocking reads are logged for Phase 11;
  - PCR-004 adds S26b (four tools) before S27.

  The rest are Claude's defaults below.
- **Date:** 2026-10-21
- **Builds on:** ADR-0005 (the model proposes, the domain decides), ADR-0019 (design system), ADR-0028 (trust layer), ADR-0029 (tools), ADR-0030 (agent loop, SSE), the [Phase 6 playbook](../plan/phase-6-playbook.md) principles 1, 6, 8, 9 and §7 "S26".
- **Amends:** ADR-0028 §3, §5 and §6 (the proposal's tool version; the receipt's requester and summary; who may undo), and ADR-0029 §2 (`ToolDeps.requester`).

## Context
S22–S25 built the AI's port, trust layer, tools and loop, all proven without a screen. S26 puts them in the members' hands: chat on a phone, between clients. This is where the differentiators become visible:
- **D-1:** the card shows exactly what will change, from the domain's dry run;
- **D-2:** every action has Why? and Undo;
- **D-4:** staff get the same AI, limited to their own permissions;
- **D-5:** every screen works with the AI down.

Guidance re-checked at the brief:
- **OWASP LLM10:2026 (improper output handling):** treat model output as untrusted at every boundary, with schemas, allowlists and encoding.
- **WCAG 2.2 SC 4.1.3 and ARIA23:** a chat log is a polite live region that exists before content arrives; status messages never move focus.
- **Microsoft's Guidelines for Human-AI Interaction:**
  - G1/G2: make clear what the AI can do;
  - G8/G9: support efficient dismissal and correction;
  - G11: explain why;
  - G12: remember recent interactions;
  - G17: global controls.
- **Google PAIR:** explanations for calibrated trust; errors that give a path forward and fall back to non-AI options.

## Decision
1. **Live views behind every card** (`contracts/ai-views.ts`, `/v1/ai`).
   - A card in the stream or in history is a snapshot. Each card reads its record by id: `GET /v1/ai/proposals/:id` and `GET /v1/ai/actions/:id`. So a card in history never offers Approve for something already decided.
   - The views carry:
     - the tool's own summary (its code's words, never the model's);
     - before/after;
     - each email's live status (waiting with its send time, sent, taken back, failed);
     - the undo window;
     - who decided (first names only);
     - whether the viewer may decide or undo;
     - *Why?*.
   - The views refuse contacts. The api parses every answer against the contract on the way out (OWASP LLM10).
   - `GET /v1/ai/proposals` (waiting, staff: their own) and `GET /v1/ai/actions` ("Done for you") feed Home until the Phase 8 feed takes them over.
2. **Approve, reject and undo by id.**
   - `POST /v1/ai/proposals/:id/approve` takes only `{ fingerprint }`, the one the card showed. It answers with one of:
     - `executed`, with the receipt;
     - `stale`, with the fresh proposal to show (nothing ran);
     - `refused`, with the tool's code, message and, for a taken time, a SlotPicker;
     - `expired`.
   - `POST /v1/ai/proposals/:id/reject` turns a proposal down.
   - `POST /v1/ai/actions/:id/undo` takes only `{ reason }`. Its answer says how many emails were taken back and how many had already left ("the client was already emailed").
   - A refused undo is 409 `undo_refused` with its reason.
   - New error codes: `proposal_not_found`, `proposal_not_pending`, `action_not_found`, `undo_window_closed`, `undo_refused`.
3. **Amendments to the trust layer** (migration 0036, ADR-0028).
   - **A proposal keeps its tool's version.** Approving one from another version answers `expired`, with nothing re-run. Its payload is not even parsed, because the schema may have changed.
   - **A receipt keeps whose request it answered** (`requested_by_user_id`) and the tool's summary.
     - Staff see a receipt a lead approved for them (RLS `member_scope` adds `requested_by_user_id = current_user_id()`), labelled "Approved by Ana".
     - They may undo it while their own role allows it (the S23 log).
   - Guard triggers keep all three immutable. Existing receipts are backfilled.
4. **"Me" stays the requester's** (ADR-0029 amendment).
   - `ToolDeps.requester` is the member whose request a call answers. Approving a proposal sets it from the stored proposal, never from the caller.
   - "Remind me", "book me" and "block my time" mean the staff member who asked, also when a lead approves.
   - Before this, the lead's dry run made "me" the lead. The fingerprint check caught it (nothing ran unseen), but the lead was then offered the wrong to-do.
5. **The chat screen** (`/chat`, `apps/web`).
   - **Transport:**
     - `fetch` reads the POST's server-sent events (EventSource can't POST), checked against `ChatEventSchema` before anyone sees them;
     - a dropped stream resumes from the last event with `Last-Event-ID` (3 tries), and each event is applied once by its sequence;
     - Stop sends cancel, and leaving the chat sends it too, with `keepalive` (S25: only an explicit stop cancels a turn; leaving the chat counts as one).
   - **Rendering:**
     - The AI's words stream into one bubble as plain text.
     - **No HTML, no Markdown:** a lint rule bans `dangerouslySetInnerHTML`, `innerHTML` and Markdown or HTML renderers in `apps/web` and `@pepper/ui`.
     - Fallback and notice links render only if they pass `ScreenLinkSchema`. That schema now also refuses `//host`.
   - **Accessibility:**
     - The transcript is a `role="log"` region, `aria-busy` while a turn streams, so a screen reader reads each answer once.
     - A polite status line says what Pepper is doing.
     - Nothing takes focus by itself. The *Why?* sheet returns focus to its button.
   - **Layout:** new content scrolls into view only when the member is already at the bottom, so reading back up is never interrupted.
   - **States:**
     - suggestion chips per role while empty;
     - "thinking" activity per tool;
     - `turn_limit` in words;
     - the deterministic fallback with its screen link;
     - AI off or paused from `GET /v1/chat/status`, with a link to the calendar (AC-X-2).
   - **The latest conversation reopens** (G12), and "New chat" starts another.
   - **A choice tapped on a card while Pepper is still answering** (a time, a client) is queued and sent when the turn ends. Before, it was silently dropped.
6. **Cards in `@pepper/ui`**, shared with the future feed.
   - `ChangeCard` covers change, confirmation and receipt: proposed, done, undone, expired, rejected, out of date or not done; Approve, Not now, Undo with its window, Why?, "Approved by".
   - `SlotPicker`, `ClientChoice`, `BookingCard`, `DayCard`, `PlanCard`, `WhyContent` and `ChatNotice`.
   - **Their wording** is pure functions (`cards/labels.ts`) over the payloads' codes, never model prose. That covers the change rows, email lines, undo line, *Why?* model, dial labels and groups.
   - **The plan card** groups a turn's two or more changes. "Approve all" approves each one exactly as shown, in order, and stops at the first that isn't done.
7. **The Autonomy page** (`/autonomy`).
   - Grouped by risk:
     - looking things up, always on;
     - changes inside Pepper;
     - messages to clients, with the bulk lock shown and disabled.
   - "Ask me first for everything" is a switch.
   - Each action is a radio group that saves at once (optimistic, rolled back if refused) and is announced.
   - Owners and managers change it; staff see it read-only; the AI never can (ADR-0028).
   - `GET` and `PUT /v1/autonomy`.
8. **A scripted model for e2e only** (`E2eModel`, `AI_SCRIPTED_PROVIDER=e2e`).
   - It is stateless: each answer depends only on the request. Parallel browsers share it, and it drives the real loop, tools and trust layer.
   - The api refuses to start with it:
     - next to an OpenAI key;
     - outside `DEPLOYMENT_ENVIRONMENT=ci`;
     - outside `local` in a non-production build.

     So a deployment that forgot its environment name still stops.
   - CI's e2e job sets it, and its outage cue doesn't trip the shared circuit breaker.

## Consequences
- **Gains:**
  - **Approve can only approve what the card shows:** the body is the fingerprint, and the stored proposal runs. A stale card shows the fresh proposal, and nothing runs (Playwright "a stale approval…", api and controller tests).
  - **Staff see and can undo what a lead approved for them,** and the requester's "me" holds through approval.
  - **Every journey runs on the real stack:** taken time → slot picker → Approve → *Why?* → Undo, ask vs notify, staff refusal, a lead-approved receipt, a stale approval, the model down, a dropped stream, and Stop or leave. The Playwright and axe suites cover them on phone and desktop.
  - **No model text can become markup:** the lint rule, component tests and outgoing contract checks hold it.
- **Costs and risks:**
  - **Each change card reads its record** once on mount (and Home lists up to 5 receipts). That is a few small requests per screen, acceptable at pilot scale. A batch endpoint is the fix if it shows up.
  - **Screen-reader behaviour while streaming** (`aria-busy` on the log) passes axe, but is not verified with NVDA or VoiceOver. To do before the pilot.
  - **The api's chat readers poll Redis every 200 ms** (S25). Blocking reads are logged for Phase 11 with the load test.
  - **Undoing a move whose email was taken back** leaves the client's earlier manage link dead (ADR-0029, still logged). The receipt can't fix it without emailing the client.
  - **Explanations still have empty `facts` and `alternatives`** (S24). *Why?* is built from the request, the steps, the change, the emails and the decision. Tools filling in facts are logged for S26b or S27.
  - **The Docker images can't be built inside the cloud sandbox** (npm through the proxy's TLS). Playwright ran on locally started apps, as `dev-setup.md` describes. CI builds the images.

## Alternatives considered
- **Trusting the stored card's state:** fewer requests, but history would offer Approve for decided proposals, and a receipt's email status would never move.
- **A batch "approve all" endpoint:** one request, but either one transaction across unrelated writes, or the same per-item outcomes. The plan card calls the single endpoint per item, in order, and stops at the first that isn't done.
- **EventSource with a GET start:** simpler parsing, but a turn starts with a body (`POST`). Fetch-reading SSE keeps one contract for start and resume.
- **Markdown in the AI's answers:** richer text, but links and markup from the model are exactly LLM10's risk. Cards carry the structure; text stays text.
- **Owners reading staff members' words in *Why?*:** fuller context, but conversations are own-only (ADR-0030). *Why?* says the request came from a teammate's own chat.
- **A scripted model behind a request header:** no restart, but a header can reach production. An environment switch refused at boot can't.
