# UX Principles

**Direction:** warm and friendly (Airbnb-like): soft rounded shapes, generous spacing, friendly microcopy, real photography/illustration accents; calm, never cluttered. Working name **Floty**. Proposed palette, type and wordmark: [`../mockups/README.md`](../mockups/README.md) (pending sign-off in S2, then recorded here).

## Principles
1. **Mobile-first, one-thumb.** Owners use the app between clients. Primary actions reachable with one thumb; works great at 375 px width.
2. **Conversation first, UI always available.** Every chat action has an equivalent screen; every screen has an "ask" entry.
3. **Cards, not walls of text.** AI responses render as typed cards: Booking, SlotPicker, ChangeDiff (before/after), ClientSummary, Suggestion, Confirmation, Undo toast.
4. **Show, then do.** For anything not set to "just do it", show exactly what will happen before it happens.
5. **Always reversible.** Undo is visible after every change; history shows who (person or AI) did what.
6. **Explain on demand.** "Why?" is one tap away, plain language, lists data used.
7. **Speak the business's language.** Terminology comes from the industry template (client/guest/member; stylist/therapist/trainer).
8. **Fast feels trustworthy.** Optimistic UI for safe actions; skeletons, not spinners; chat streams responses.
9. **Accessible.** WCAG 2.2 AA: contrast, focus states, screen-reader labels, reduced motion.
10. **Calm notifications.** Batch non-urgent items into the feed; push only for time-sensitive needs.

## Key screens (to mock up in Phase 0)
Operator feed (home) · Chat with cards · Calendar (day/week, per staff) · Client profile · "What I know" · Autonomy settings · Onboarding flow · Public booking page · Team & services.

## Design system
`packages/ui`: tokens (color, type, spacing, radius, shadow) with light/dark themes, components built on accessible primitives (e.g. Radix) + Tailwind. Card components are shared between chat and screens.
