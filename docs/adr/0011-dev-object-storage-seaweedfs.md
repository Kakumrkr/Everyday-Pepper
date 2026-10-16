# ADR-0011: Dev object storage — SeaweedFS

- **Status:** Accepted (2026-10-16, user) · **Date:** 2026-10-16 · Resolves open decision D10

## Context
The plan uses S3-compatible storage for uploads, imports and exports (`../architecture/jobs-messaging-integrations.md`), with MinIO as the local server. In S4 we found that MinIO no longer publishes community Docker images (`minio/minio` is gone from Docker Hub). The application code talks only to the S3 API, so the local server is a dev/CI choice and can be swapped later. The pilot uses a hosted service (R2 or S3).

Options considered: **SeaweedFS** (Apache-2.0, mature, one container with `server -s3`); Garage (AGPL, needs a cluster-layout bootstrap step); RustFS (Apache-2.0, young project); the last MinIO build from quay.io (frozen, no security fixes).

## Decision
Use **SeaweedFS** as the S3-compatible server in Docker Compose and in integration tests (Testcontainers, image read from `docker-compose.yml` like Postgres and Redis). The image is pinned by digest and kept current by Dependabot. It is added in Phase 4, when the first feature (stylist photos) needs storage; nothing uses storage before then.

## Consequences
+ Free, permissive licence, one container, actively maintained.
+ The S3 client code stays provider-neutral; switching servers changes only Compose and test setup.
− SeaweedFS's S3 layer covers less of the S3 API than AWS S3. Phase 4 contract tests must cover exactly the calls we use (put, get, delete, pre-signed URLs) so a gap shows up in CI rather than in the pilot.
