# Voice Readiness (ships in V2)

> Provides: constraints V1 must respect so voice drops in cleanly · Depends on: AI agent · Consumed by: V2 voice gateway

## V2 design sketch
`apps/voice-gateway` (NestJS) bridges the browser/PWA microphone (WebRTC/WebSocket) to the **OpenAI Realtime API**. Realtime tool calls are routed to the **same tool registry and domain services** as text, so risk tiers, autonomy dial, explanations and undo apply unchanged. Confirmations for `ask` actions are spoken and mirrored as on-screen cards. Phone calls (telephony) are a later, separate decision.

## Constraints on V1 (must hold now)
1. Agent core is transport-agnostic: input/output via a `Turn` abstraction, not HTTP-specific code.
2. Tool handlers return structured results + a short spoken-friendly summary field.
3. Conversation model has a `channel` field (`app`, later `voice`, `sms`).
4. Latency budget tracked per tool (voice needs < 1 s for common reads).
5. Audio, if stored, goes to object storage with retention policy — off by default.
