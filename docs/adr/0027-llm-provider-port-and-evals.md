# ADR-0027: The LLM provider port, OpenAI adapter, metering and eval runner

- **Status:** Accepted (user, 2026-10-20, as proposed; drafted by Claude in S22). The user chose the official `openai` SDK, a **$5 OpenAI budget for all of Phase 6, spent only at the final testing stage (S27)**, and confirmed the [Phase 6 playbook](../plan/phase-6-playbook.md). The rest are Claude's defaults below. · **Date:** 2026-10-20 · Builds on ADR-0004 (provider adapter), ADR-0005 (the model proposes, the domain decides), ADR-0013 (metering)

## Context
Phase 6 starts the AI layer. ADR-0004 put OpenAI behind an adapter with model ids in configuration and an eval gate. This session builds that adapter and the eval runner before any tool or agent loop exists. The budget means no real call may happen until S27, so everything must be provable with fakes and with fixtures shaped like OpenAI's documented responses, and the runner must refuse to overspend once real calls start.

## Decision
1. **A provider-neutral model** in `packages/contracts/src/ai.ts` (Zod):
   - **Messages:**
     - `user` (text).
     - `assistant` (text, tool calls, and an opaque `replay` list).
     - `tool` (the result for one tool call id, text, `isError`).
   - **Tool definitions:**
     - `name` is `verb_noun` in snake case, at most 64 characters.
     - `description` is at most 1,024 characters.
     - `parameters` is a strict JSON Schema object.
   - **Tool calls** keep the model's raw JSON `arguments` string. The tool registry (S24) parses them with the tool's Zod schema; nothing in the adapter trusts them.
   - **Requests** carry:
     - a **route** (`routine` / `strong`), never a model id;
     - `instructions` (the system prompt), messages and tools;
     - `toolChoice` (`auto` / `none` / `required`) and `maxOutputTokens`;
     - an optional `cacheKey` (prompt-cache routing, per business);
     - an optional `safetyId` (a hash of the user, for the provider's abuse detection).
   - **Responses** carry:
     - text, tool calls and `replay`;
     - `finishReason`: `stop`, `tool_calls`, `length`, `refused` or `content_filter`, with the refusal text;
     - usage: input, cached input and output tokens;
     - the model id that answered.
   - **Stream events:** `text_delta` and `done` (with the full response).
   - **Error codes:** `timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`, `invalid_response`, `aborted`, `budget_exceeded`. Each has a `retryable` flag.
   - `replay` holds provider items the next request must send back unchanged: reasoning items with their encrypted content, and an assistant message's `phase`. Reasoning models degrade when these are dropped between tool calls, and with `store: false` the provider keeps no state for us. It is opaque JSON, never shown, and only the provider that wrote it reads it.
2. **The port** (`packages/ai`): `LlmProvider { respond(request, { signal }) ; stream(request, { signal }) }`, and `LlmError` carrying one of the codes above.
   - **`OpenAiProvider`:**
     - Uses the official `openai` SDK, **7.32.0, pinned**, imported only in `packages/ai`, on the **Responses API**.
     - Every request sends `store: false` (OpenAI keeps no conversation state, D-5), `include: ['reasoning.encrypted_content']`, `parallel_tool_calls: true`, `prompt_cache_key` from `cacheKey` and `safety_identifier` from `safetyId`.
     - Tools are sent as `function` tools with `strict: true`.
     - **Retries are ours, not the SDK's (`maxRetries: 0`)**, so the agent loop (S25) decides with its time budget in view.
     - The timeout defaults to 30 s.
     - SDK errors map to our codes:
       - timeout and connection errors → `timeout` / `unavailable` (retryable);
       - 429 → `rate_limited` (retryable), except `insufficient_quota` → `budget_exceeded` (not retryable);
       - 5xx → `unavailable`;
       - 401/403 → `auth`;
       - other 4xx → `bad_request`;
       - an unparseable or unexpected answer → `invalid_response`.
     - SDK types never leave the adapter.
3. **Strict tool schemas from Zod.** `strictToolParameters(zodSchema)` converts with Zod's JSON Schema export (input side). It then:
   - **refuses** any object with an optional property or without `additionalProperties: false`, because OpenAI strict mode needs every field required (optional ones are written `.nullable()`, with `z.strictObject`);
   - **drops** keywords outside a conservative allow-list (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `description`, `pattern`, `format`, numeric bounds, `minItems`/`maxItems`, `$ref`/`$defs`).

   Dropped constraints still hold, because the registry parses the arguments with the full Zod schema before anything runs.
4. **Model routing is configuration.** `loadOpenAiConfig(env)` reads:
   - `OPENAI_API_KEY`: unset means AI off. It is a secret, never logged.
   - `OPENAI_MODEL_ROUTINE` and `OPENAI_MODEL_STRONG`: **required when the key is set, no defaults.** The models are chosen from eval results in S27 (D5).
   - `OPENAI_BASE_URL`: optional, https only, for a proxy.
   - `OPENAI_TIMEOUT_MS`.

   The api and worker wire it in S25.
5. **Metering.** `meteredProvider(provider, meter)` reports every answer's usage, from both `respond` and the stream's `done`, to a `meter` callback. The apps bind it to core's `recordUsage(…, { metric: 'llm_tokens', amount: input + output })` with the session's business (S25). A call that fails before an answer has no usage to report. A response that fails after the model started (`response.failed`) may still be billed, so the adapter attaches that response's usage to the `LlmError` and the wrapper meters it too. An `incomplete` response (output limit, content filter) is an answer with its finish reason, metered like any other.
6. **Fakes are first-class.** `ScriptedProvider` answers from a list of steps (fixed responses, functions of the request, or errors), records every request and fails loudly when the script runs out. It satisfies the same contract suite as the OpenAI adapter. The **hostile fake** joins in S24, once tools exist.
7. **Eval runner** (`packages/ai/src/evals`, `pnpm --filter @pepper/ai eval`).
   - **A case** (Zod) has:
     - `id`, `set` (scheduling, ambiguity, permissions, autonomy, safety, failure, follow_through) and a description;
     - the business `now` and time zone;
     - the actor's role;
     - the user's turns;
     - the tools offered;
     - **expectations:**
       - `toolCalls`: name, plus argument matchers that are JSON values, `{ "$regex": … }` or `{ "$any": true }`, partial for objects;
       - `noToolCalls` and `mustNotCall`;
       - `replyMatches` and `replyMustNotMatch`.

     The seeded world and final-state checks arrive with the tools (S24).
   - **The subject:** S22's is one model call per user turn. The agent loop replaces it in S25.
   - **Graders are deterministic code.** There is no LLM-as-judge in Phase 6.
   - **pass^k:** each case runs k times and passes only if every run passes.
   - **Cassettes:** each case and step has a recorded or hand-written response in a JSON file. In replay mode the runner answers from it.
     - An entry with a request fingerprint (SHA-256 of the normalised request) must match, or the case fails as `stale`, so a changed prompt or tool can never silently reuse an old answer.
     - A hand-written entry has no fingerprint.
     - Record mode (S27) calls the real provider and writes the entry with its fingerprint.
   - **Budget guard:**
     - Before a real run the runner estimates the cost from the tokens of the requests it will send, a per-call output allowance and a price table. Prices are configuration, re-checked on OpenAI's pricing page at S27.
     - It **refuses above a per-run cap ($1.50 by default)**. The cap must be a positive number of at most $4.50, so a mistyped cap can never mean "no cap".
     - It refuses without a price for the model.
     - The cumulative ledger and its $4.50 stop come in S27.
     - The fake and cassette runs cost $0. CI never calls OpenAI.
   - **The report** (JSON and Markdown): pass rates per set, failing cases with reasons, tokens and estimated cost.
   - **Sample cases:** S22 ships three reference cases (a booking request that must look the client up first, a day summary on the business clock, a prompt-injection request that must call no write tool). Each has a hand-written cassette and runs on the fake.

## Consequences
- **Gains:**
  - Every later session builds on fakes that behave like the real API's documented shape, so S23–S26 cost nothing and CI stays free of keys.
  - Prompt caching, no provider-side storage and reasoning replay are designed in from the start, not retrofitted.
  - The eval runner can already block a regression, and it cannot overspend.
- **Costs and risks:**
  - The adapter is proven against fixtures, not the live API, until S27's smoke step. A documented-but-wrong field would surface only then (it is the smoke step's purpose, ≤ $0.10).
  - Strict schemas forbid optional fields, so tool arguments use `null` for "not given".
  - The SDK publishes almost daily. We pin a version at least a week old and update deliberately.

## Alternatives considered
- **Hand-written `fetch` instead of the SDK:** less dependency surface, but we would maintain SSE parsing and error typing ourselves. The user chose the SDK.
- **Chat Completions API:** the most widely copied shape, but OpenAI's newer features (reasoning replay with `store: false`, cache routing) are on the Responses API. Our neutral model keeps a later switch, or another provider, possible.
- **The SDK's built-in retries:** they hide time spent from the agent loop's 20 s budget. We retry ourselves.
- **LLM-as-judge grading now:** costs budget and adds noise. Deterministic graders judge the tool calls and, from S24, the final state.
- **A free local model for development:** its tool calling differs from OpenAI's, so evals would mislead. Not chosen (S22 brief).
