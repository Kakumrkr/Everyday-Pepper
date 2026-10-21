# Open Decisions

Resolved decisions move into an ADR (`../adr/`) and are logged in `CHANGELOG.md`.

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Product name & brand | **Working name: Pepper** (user, 2026-10-16). Confirm trademark/domain before pilot | Before pilot |
| D2 | Auth solution | ✅ **Resolved: Better Auth** → [ADR-0007](../adr/0007-auth-better-auth.md) | — |
| D3 | ORM / migrations | ✅ **Resolved: Drizzle** → [ADR-0008](../adr/0008-orm-drizzle.md) | — |
| D4 | Email provider | ✅ **Resolved: Resend for the pilot** (user, S19), behind the `Mailer` port; Mailpit over SMTP in development and CI → [ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md). Revisit SES at scale | — |
| D5 | OpenAI models | Small model for routine turns, stronger model for planning/extraction; pin via config (`OPENAI_MODEL_ROUTINE`/`_STRONG`, ADR-0027) and choose from eval results within the $5 budget | S27 |
| D6 | Pilot host | Hetzner VPS (cheapest) vs AWS Lightsail (closer to AWS later) | Phase 11 |
| D7 | Pricing & plan limits | Monthly per business with included AI/email usage; finalise from metering data | Before pilot |
| D8 | Real-time transport for chat | **Decided (S25, ADR-0030): SSE** for a turn's events (resumable with `Last-Event-ID`) + REST for actions | Phase 6 |
| D9 | IaC tool for AWS | Terraform vs CDK | Growth stage |
| D10 | Dev object storage (S3-compatible) | ✅ **Resolved: SeaweedFS** (user, 2026-10-16) → [ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md). Added to Compose in Phase 4 | — |
