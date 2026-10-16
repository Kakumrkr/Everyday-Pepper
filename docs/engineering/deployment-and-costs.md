# Deployment, Environments & Costs

Goal: near-zero cost while building, cheap pilot, AWS only when revenue justifies it. Everything is containerised so moving hosts is a config change, not a rewrite.

## Environments
| Env | Where | Contents |
|---|---|---|
| dev | Local / cloud dev session via Docker Compose | web, api, worker, Postgres+pgvector, Redis, MinIO, Mailpit (fake email) |
| CI | GitHub Actions | lint, typecheck, unit, integration (Testcontainers), E2E, evals (budget-capped), image build, security scans |
| staging | Same VPS as pilot, separate compose project & DB | Deployed on merge to main |
| pilot/prod | One small VPS (Hetzner ~$5–10/mo or AWS Lightsail ~$10–20/mo) | Docker Compose + Caddy (TLS), nightly encrypted backups to R2/S3 |
| growth | AWS: ECS Fargate, RDS Postgres, ElastiCache Redis, S3, CloudFront | IaC (Terraform or CDK — ADR when needed) |

Production deploys require the user's approval (CLAUDE.md principle 9).

## CI/CD
PR: lint → typecheck → unit → integration → E2E → evals (when AI files change) → build. Main: build images → deploy staging → smoke tests. Prod: manual approval → deploy → smoke → automatic rollback to previous image on failure.

## Estimated monthly costs
| Item | Build phase | Pilot (5–10 businesses) |
|---|---|---|
| Hosting | $0 (local) | $10–25 (VPS) |
| OpenAI API | $5–15 (dev, hard cap) | ~$1–5 per business (small model default; to be measured) |
| Email | $0 (Mailpit) | ~$0–5 (SES $0.10/1k or Resend free tier) |
| Storage/backups | $0 | $0–2 (R2 free tier/S3) |
| Sentry, Grafana Cloud, GitHub Actions | $0 (free tiers) | $0 |
| Domain | ~$1/mo amortised | ~$1 |
| **Total** | **~$5–15** | **~$20–50** |

Set hard spend limits on the OpenAI account from day one. Re-estimate after Phase 6 with real token measurements.

## Accounts needed (user to create, in order)
1. GitHub (have) · 2. OpenAI API (Phase 6) · 3. Domain (before pilot) · 4. Google Cloud project for Calendar OAuth (Phase 10; verification needs company + domain) · 5. Email provider (Phase 5 for staging) · 6. Sentry / Grafana Cloud (Phase 1) · 7. VPS (Phase 11) · 8. Company entity (LLC) before pilot — required for OAuth verification, ToS/Privacy Policy, and later SMS registration and Stripe.
