# ADR-0007: Authentication with Better Auth (self-hosted)

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16 · Resolves open decision D2

## Context
Need email/password and social login, MFA for owners, secure sessions, and multi-tenant memberships — at zero cost, with data in our own Postgres.

## Decision
Use Better Auth (open-source TypeScript auth library) running in `apps/api`, storing users/sessions in our Postgres. Session cookies (HttpOnly, Secure, SameSite). MFA (TOTP) available and enforced for owners. Tenant membership and roles stay in our own `Membership` table; auth only proves identity. Wrapped behind an internal `AuthService` interface so it can be replaced.

## Consequences
+ Free, no vendor lock-in, user data stays in our DB.
− We own security updates and configuration; mitigated by keeping the library current, auth E2E tests, and security review in Phase 2.
