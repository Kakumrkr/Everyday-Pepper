# Traceability Matrix

Links each requirement to its design and tests. Test columns are filled in as phases are built; an empty test cell at phase exit is a blocker.

| Requirement | Design | Phase | Tests |
|---|---|---|---|
| AC-W1-1/2 onboarding draft & confirm | jobs-messaging-integrations (extraction), modules-and-templates | 9 | _tbd_ |
| AC-W1-3 CSV import idempotent | jobs-messaging-integrations | 9 | _tbd_ |
| AC-W2-1 conflict → alternatives | modules-and-templates (availability), ai-agent | 3, 6 | _tbd_ |
| AC-W2-2 autonomy "ask" | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-3 undo | ai-agent-and-trust-layer | 6 | _tbd_ |
| AC-W2-4 staff permission | security-and-tenancy | 2, 6 | _tbd_ |
| AC-W3-1/2 facts & warnings | memory | 7 | _tbd_ |
| AC-W4-1/2 feed suggestion, no duplicates | jobs-messaging-integrations, feed | 5, 8 | _tbd_ |
| AC-W5-1 waitlist | modules-and-templates | 8 | _tbd_ |
| AC-W6-1 reminders | jobs-messaging-integrations | 5 | _tbd_ |
| AC-W7-1/2/3 trust | ai-agent-and-trust-layer, memory | 6, 7 | _tbd_ |
| AC-W8-1/2 public booking | data-model (exclusion constraint), security | 3, 4 | _tbd_ |
| AC-W9-1 staff scope | security-and-tenancy | 2 | _tbd_ |
| AC-X-1 tenant isolation | security-and-tenancy | 2+ | _tbd_ |
| AC-X-2 LLM outage degradation | reliability-and-observability | 6 | _tbd_ |
