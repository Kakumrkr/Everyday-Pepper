# Open Decisions

Resolved decisions move into an ADR (`../adr/`) and are logged in `CHANGELOG.md`.

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Product name & brand | **Working name: Floty** (user, 2026-10-16). Confirm trademark/domain before pilot | Before pilot |
| D2 | Auth solution | ✅ **Resolved: Better Auth** → [ADR-0007](../adr/0007-auth-better-auth.md) | — |
| D3 | ORM / migrations | ✅ **Resolved: Drizzle** → [ADR-0008](../adr/0008-orm-drizzle.md) | — |
| D4 | Email provider | Amazon SES (cheapest) vs Resend (simplest DX) — recommend Resend for pilot, SES at scale | Phase 5 |
| D5 | OpenAI models | Small model for routine turns, stronger model for planning/extraction; pin via config and evals | Phase 6 |
| D6 | Pilot host | Hetzner VPS (cheapest) vs AWS Lightsail (closer to AWS later) | Phase 11 |
| D7 | Pricing & plan limits | Monthly per business with included AI/email usage; finalise from metering data | Before pilot |
| D8 | Real-time transport for chat | SSE for streaming + REST for actions vs WebSocket — recommend SSE (simpler, proxy-friendly) | Phase 6 |
| D9 | IaC tool for AWS | Terraform vs CDK | Growth stage |
| D10 | Dev object storage (S3-compatible) | ✅ **Resolved: SeaweedFS** (user, 2026-10-16) → [ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md). Added to Compose in Phase 4 | — |
