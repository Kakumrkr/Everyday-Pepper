# syntax=docker/dockerfile:1
# One build for all apps; pick one with --target api|worker|web (docker-compose.yml does).
# Base images are pinned by digest; Dependabot proposes updates.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- build: install the whole workspace, compile every app and package ----
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@floty/api --filter=@floty/worker --filter=@floty/web
# Production-only, self-contained copies of the Nest apps (workspace packages included as dist).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@floty/api deploy --prod --legacy /out/api && \
    pnpm --filter=@floty/worker deploy --prod --legacy /out/worker

# ---- runtime images: no build tools, no sources, non-root ----
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:4000/health/ready || exit 1
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:4100/health/ready || exit 1
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]

FROM runtime AS web
# Next.js standalone output keeps the monorepo layout: the server lives at apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
ENV HOSTNAME=0.0.0.0 \
    PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "apps/web/server.js"]
