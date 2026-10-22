# Security review: Phase 6 (S22–S27), done in S27

- **Date:** 2026-10-22 · **Scope:** the whole AI layer:
  - the provider port and OpenAI adapter (S22, ADR-0027);
  - the trust layer (S23, ADR-0028);
  - the tool registry and fourteen tools (S24, S26b, ADR-0029, ADR-0032);
  - the agent loop and conversations (S25, ADR-0030);
  - the chat screen, cards, *Why?*, Undo and the Autonomy settings (S26, ADR-0031);
  - the S27 eval runner, budget guards and real-model runs.
- **Method:**
  - A read of the code against the [Phase 6 playbook §6](../plan/phase-6-playbook.md) checklist, re-mapped to the **OWASP Top 10 for LLM Applications 2026** and the **OWASP Top 10 for Agentic Applications (2026)**.
  - The hostile fake's attacks, the eval sets on the fakes and on the real model, and `pnpm audit`.
- **Source check:**
  - The 2026 LLM list's order comes from secondary sources that agree with each other (published August 2026; Excessive Agency up to LLM03, System Prompt Leakage broadened into Hidden Context Exposure at LLM08). owasp.org was not reachable from this session's network when this was written: see "To confirm" at the end.
  - The agentic list's titles (ASI01–ASI10) are as published by OWASP's GenAI project in December 2025.
- **Policy (as in S18 and S21):** fix high and medium findings now, each with a test; log low ones for Phase 11.

## Result
No high-severity findings. Two medium findings from the S26b log were fixed in S27 with tests (M1, M2). One test is still being watched (W1). Four low findings are open.

| # | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | **Tool summaries echoed stored text unlabelled.** `complete_todo`'s answer to the model repeats the to-do's title ("Mark your to-do "…" done"). A to-do Pepper created may carry a pasted client message's words. That answer reached the model as trusted text, and the turn stayed trusted, so an instruction hidden in an AI-written title could steer the rest of the turn without the "untrusted context → external actions ask" rule applying. (`list_todos` already labelled it; the write path did not.) | **Fixed (S27):** write outcomes carry `untrustedText`. `Performed.untrustedText` is set by `complete_todo` when the to-do's source is not `manual`. The loop labels the answer as untrusted data and marks the turn untrusted. A proposal found again without a fresh dry run is labelled anyway. Tests: `writes.int.test.ts` "labels its answer untrusted when it echoes the AI's own to-do title", `loop.test.ts` "labels a write answer that echoes untrusted text…"; both fail with the fix removed. |
| M2 | Medium | **Undoing an unblock could hide a client.** Undo of `unblock_time` put the block back even when a client had been booked into the freed time since. The owner would see a break while a client walks in, the opposite of D-2 ("Undo is safe"). | **Fixed (S27, user's choice at the brief):** the inverse keeps the bookings already inside the block. A booking made since refuses the Undo as `slot_taken` ("That time has been booked since, so I can't put it back. Nothing was changed."). Once that booking is cancelled, Undo works again. Older receipts without the list refuse whenever any booking is inside (fail-closed). Test: `writes.int.test.ts` "its undo is refused once a client was booked into the freed time…"; it fails with the fix removed. |
| W1 | Watch | **`reads.int.test.ts` "list_todos" failed once in S26b** with no visible diff, then passed. In S27 it passed **61 repeats in one run** plus every full-suite run. The read has no clock or ordering dependency (open first, by due time, then `created_at`, then id; "overdue" uses the injected clock). | Not reproduced. Kept as is (no retry or skip). A new failure gets its diff logged and is fixed then. |
| L1 | Low | **A turn may propose many single cancellations.** The bulk lock counts recipients per action. A model told "cancel everything" can propose one cancellation per booking: at most 5 writes an answer and 6 steps a turn, each waiting for the OK ("Approve all" approves them in order). Nothing runs without a person. | Accepted for V1 (people approve). Phase 8: a per-turn plan limit with "this touches N clients" on the plan card. |
| L2 | Low | **Zero data retention is not yet confirmed.** Requests go with `store: false` and no training on API data, but the account's zero-retention eligibility is still unchecked. | Before the pilot (Phase 11), on the OpenAI account. |
| L3 | Low | **Cassettes keep OpenAI's encrypted reasoning items** (`replay`) in the repository. They are opaque, encrypted by OpenAI for this organisation, and come from the fake eval world only (no real business data). | Accepted; the repo is private. Re-record if the organisation's key material changes. |
| L4 | Low | **`pnpm audit`** (dev tooling only, as in S18 and S21): `braces` (lint toolchain) and `esbuild` (drizzle-kit). `pnpm audit --prod`: no known vulnerabilities; `openai` 7.32.0 included. | Re-check when patches ship. |

The open low findings of S18 and S21 stay as recorded there.

## OWASP Top 10 for LLM Applications 2026: controls and proof

| Risk | Our control | Proven by |
|---|---|---|
| **LLM01 Prompt injection** | <ul><li>Untrusted text (pasted messages, client-typed names, the AI's own to-dos, and now the write answers that echo them, M1) is JSON-wrapped and labelled every time it is sent; the taint spreads to the rest of the turn and to later turns.</li><li>An untrusted turn makes external actions ask, whatever the dial says.</li><li>The instructions say untrusted text is information only.</li><li>The model cannot approve, undo or change autonomy (no such tools; people-only endpoints).</li></ul> | The hostile fake through the real loop (100%); safety evals (pasted review, forwarded email, Spanish injection, "SYSTEM NOTICE", role-play, an injected client name) on the fakes and the real model at pass^3 |
| **LLM02 Sensitive information disclosure** | <ul><li>No client email or phone number ever reaches the model: tools return ids, first names and initials; to-do titles go through `redactContacts`; members' messages are redacted.</li><li>RLS and member scope on every table; conversations are own-only.</li><li>`store: false`; no contents in logs or spans.</li></ul> | Prompt-content and tool-answer tests per role; the "client phone number", "other clients in reply" and "staff asks for owner data" evals |
| **LLM03 Excessive agency** | <ul><li>Fourteen narrow tools; the risk tier and the dial decided inside the trust layer from the domain's own dry run.</li><li>The bulk lock; at most 5 writes and 8 calls an answer, 6 steps and 20 s a turn.</li><li>Staff limited to their own permissions; Approve sends only the shown fingerprint.</li></ul> | `decideAutonomy` property tests; the role matrix through the tools (AC-W2-4); the autonomy and permissions evals; hostile "write after ask" attacks |
| **LLM04 Supply chain** | `openai` pinned (7.32.0) and imported only in `packages/ai`; `pnpm audit --prod` clean | `pnpm audit --prod` |
| **LLM05 Data and model poisoning** | Not in Phase 6: there is no memory or training. Phase 7 (memory) gets its own review. | — |
| **LLM06 Unbounded consumption** | <ul><li>A per-business monthly token budget reserved atomically before every call (soft 80% → routine model only, hard → AI paused, screens still work).</li><li>Per-member, per-business and per-address rate limits; step and time limits.</li><li>In S27, the eval runner's own budget guards ($1.50 a run, $4.50 in total, a stop during the run, ≤ 25 cases a run, the ledger).</li></ul> | Budget and rate-limit integration tests; `ledger.test.ts`, `cost.test.ts` |
| **LLM07 Misinformation** | <ul><li>Every business fact comes from a tool; the instructions say "say you do not know".</li><li>"Never say something is done unless a tool answered done."</li><li>*Why?* is built from recorded facts, not prose.</li></ul> | The autonomy evals (`replyMustNotMatch` "I cancelled" when only proposed); the explanation-facts tests |
| **LLM08 Hidden context exposure** | The instructions hold no secrets, keys or other businesses' data, so leaking them is harmless by design; the key lives only in the environment. | The "show system prompt" and "API key request" evals |
| **LLM09 Vector and embedding weaknesses** | Not in Phase 6 (no embeddings); Phase 7. | — |
| **LLM10 Improper output handling** | <ul><li>The AI's text renders as React text only (a lint rule bans HTML/Markdown renderers).</li><li>Streamed events are parsed with Zod in the browser; `/v1/ai` views are parsed on the way out.</li><li>Links come only from `ScreenLinkSchema` (no `//host`).</li></ul> | UI and api tests (S26); the "markdown link out" eval |

## OWASP Top 10 for Agentic Applications (2026)

| Risk | Our control |
|---|---|
| **ASI01 Agent goal hijack** | As LLM01. Goals come only from the member's own message; untrusted text can't raise autonomy or make an external action run without a card. |
| **ASI02 Tool misuse and exploitation** | Arguments are validated twice (strict JSON Schema, then Zod). Ids are checked by the domain under RLS. The hostile fake attacks every tool with other businesses' ids, smuggled fields, a booking's id as blocked time or as a to-do, and contacts where ids go: 100% stopped. |
| **ASI03 Identity and privilege abuse** | The business, member and role come from the session only, never from the model. The actor is recorded as `ai_on_behalf_of` the member. A lead's approval keeps the requester's "me". Approvers' roles are re-checked at approval. |
| **ASI04 Agentic supply chain** | One provider SDK, pinned; no plugins, MCP servers or third-party tools; model ids are configuration. |
| **ASI05 Unexpected code execution** | The model's output is never executed or evaluated. It only names one of the fourteen registered tools, whose arguments are data. |
| **ASI06 Memory and context poisoning** | Untrusted messages stay labelled in history every time they are re-sent; answers written after them are tainted too; conversations are deleted after 90 days. Long-term memory is Phase 7. |
| **ASI07 Insecure inter-agent communication** | Not applicable: one agent, no agent-to-agent channel. |
| **ASI08 Cascading failures** | A circuit breaker (3 failures → 30 s), one retry at most, a deterministic fallback with a screen link, and every screen working without the AI (AC-X-2). Writes are idempotent per tool call; abandoned turns are recovered by reading the trust layer, never by calling a tool again. |
| **ASI09 Human-agent trust exploitation** | Exact previews from a rolled-back dry run (D-1); Approve runs only the fingerprint shown; *Why?* from facts; the AI never says "done" for a proposal (evals); Undo with its window; M2 makes Undo refuse rather than hide a client. |
| **ASI10 Rogue agents** | The agent has no standing goals, schedules or self-modifying instructions: it runs only inside a member's turn, bounded by steps, time and writes, and every action has a receipt. |

## Checked and fine
- **The key:**
  - `OPENAI_API_KEY` is read only from the environment (`loadOpenAiConfig`); configuration errors name variables, never values.
  - The eval CLI prints the model ids and money, never the key.
  - Cassettes store answers and a SHA-256 fingerprint of the request, never the request itself.
- **Recording never pays twice:** a recording replays an earlier answer for an unchanged request (`replayOrRecordProvider`), and CI only replays (`evals.int.test.ts`; a stale cassette fails as `stale`).
- **The eval world** is fake data seeded per run; the model sees only what the tools return to the acting member.
- **The trust layer's guard rails** (S23–S26) were re-read and are unchanged: preview = execution, the fingerprint covers only the touched rows, one pending proposal per target, people-only approve and undo, undo through the domain.

## Accessibility of the streamed chat (S26 log item: check NVDA/VoiceOver)
The chat uses the standard pattern:
- The conversation is a `role="log"` region (polite, announces additions) with `aria-busy` while a turn runs, and each streaming answer is `aria-busy` too, so a screen reader reads the finished answer once instead of word by word.
- A separate `role="status"` line says "Pepper is thinking…".
- Speaker labels ("You:", "Pepper:") are visually hidden text.
- axe passes on phone and desktop (S26).

**Not checked by hand in S27, and why:** the session runs in a headless Linux container with no Windows, macOS or audio, so NVDA and VoiceOver cannot run there. Screen readers differ in how they honour `aria-busy` (some read deltas anyway), so this needs a person. **A 5-minute check for the user (before the pilot):**
1. iPhone: Settings → Accessibility → VoiceOver on. Open Pepper → Chat, ask "What's on today?". Expected: "Pepper is thinking…" once, then the whole answer once, not word by word. Then a card: its buttons are reachable by swiping.
2. Windows with NVDA (free) and Chrome: the same question. Expected: the same.
3. If either reads word by word, note which and tell Claude: the fix is to announce only the finished text in a hidden polite region and mark the visible streaming text `aria-hidden` until done.

## Real-model results (S27)
Filled in from the runs recorded in [ai-budget.md](../plan/ai-budget.md); see ADR-0033.

## To confirm
- The 2026 LLM list's numbering and the agentic list's titles on owasp.org (`genai.owasp.org`), once the domain is allowed. If anything differs, re-map this table.
