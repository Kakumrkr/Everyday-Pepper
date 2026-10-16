# ADR-0004: OpenAI behind a provider adapter

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16

## Context
User selected the OpenAI API (and Realtime API for V2 voice). Models, prices and capabilities change frequently.

## Decision
`packages/ai` defines an `LlmProvider` interface (chat, stream, structured output, embeddings). OpenAI is the implementation. Model IDs and per-task model routing are configuration. Any model/prompt change must pass the eval suite before merge.

## Consequences
+ Swappable models/providers; testable with a fake provider.
+ Cost control by routing routine turns to small models.
− Lowest-common-denominator risk; provider-specific features exposed via optional capabilities.
