# Open Decisions

Resolved decisions move into an ADR (`../adr/`) and are logged in `CHANGELOG.md`.

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Product name & brand | User to choose; Claude can propose options | Phase 0 (mockups) |
| D2 | Auth solution | Better Auth (self-hosted, free, works with NestJS) vs Auth.js vs Clerk free tier — recommend Better Auth for cost and control | Phase 2 |
| D3 | ORM / migrations | Drizzle (SQL-first, good for RLS and exclusion constraints) vs Prisma — recommend Drizzle | Phase 1 |
| D4 | Email provider | Amazon SES (cheapest) vs Resend (simplest DX) — recommend Resend for pilot, SES at scale | Phase 5 |
| D5 | OpenAI models | Small model for routine turns, stronger model for planning/extraction; pin via config and evals | Phase 6 |
| D6 | Pilot host | Hetzner VPS (cheapest) vs AWS Lightsail (closer to AWS later) | Phase 11 |
| D7 | Pricing & plan limits | Monthly per business with included AI/email usage; finalise from metering data | Before pilot |
| D8 | Real-time transport for chat | SSE for streaming + REST for actions vs WebSocket — recommend SSE (simpler, proxy-friendly) | Phase 6 |
| D9 | IaC tool for AWS | Terraform vs CDK | Growth stage |
