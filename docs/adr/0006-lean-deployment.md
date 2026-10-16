# ADR-0006: Lean deployment path — Docker Compose → single VPS → AWS

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16

## Context
User has a tight budget; AWS is the long-term target.

## Decision
All services containerised. Dev on Docker Compose ($0). Pilot on one small VPS with Docker Compose, Caddy, nightly encrypted backups to object storage, free-tier Sentry/Grafana Cloud. Move to AWS (ECS Fargate, RDS, ElastiCache, S3) via IaC when paying customers justify it. No AWS-specific APIs in application code (S3-compatible storage interface, standard Postgres/Redis).

## Consequences
+ ~$5–15/mo while building, ~$20–50/mo for pilot.
+ Migration to AWS is an infra change only.
− Single-VPS pilot has no high availability; accepted for pilot with backups, monitoring and a restore drill.
