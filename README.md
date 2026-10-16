# Floty

The "AI Employee" for small appointment-based service businesses (working name). Start with [`docs/README.md`](docs/README.md); current status and next steps are in [`docs/plan/STATUS.md`](docs/plan/STATUS.md). Rules for contributors (and Claude Code sessions) are in [`CLAUDE.md`](CLAUDE.md).

## Quick start

```sh
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm check               # format, lint, typecheck, tests (coverage gate), build — same as CI
docker compose up --build --wait   # web :3000 · api :4000 · worker :4100 · Mailpit :8025
pnpm test:e2e            # Playwright smoke test against the running stack
```

See [`docs/engineering/dev-setup.md`](docs/engineering/dev-setup.md) for commands, conventions and the branch/PR workflow.
