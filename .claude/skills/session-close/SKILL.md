---
name: session-close
description: Close a Pepper session - the full checks once and in order, a review of the diff, the four docs, one PR, one green CI run, merge, and the next session's prompt. Use when a session's tasks are done, or when the user says to wrap up, open the PR or merge.
---

# Closing a session (M2, user-approved workflow)

Every suite runs in full here, once, one at a time (suites run side by side on this machine time out and fail for no real reason). Long runs go in the background (`run_in_background`), output to `<scratchpad>/<name>.log`; read only the summary lines (`tail`, `grep -E "passed|failed|✗"`), and the failure itself only if there is one.

## 1. Checks, in this order (stop and fix at the first red; a fix re-runs that step only, then goes on)

1. `pnpm check` (format, lint, typecheck, unit tests with coverage, build).
2. `pnpm test:integration`, alone.
3. Playwright, alone, only if a screen or flow changed:
   ```sh
   .claude/skills/session-close/e2e-stack.sh start <scratchpad>
   pnpm --filter @pepper/e2e test:e2e --workers=3      # the full suite, once
   .claude/skills/session-close/e2e-stack.sh stop
   ```
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE` comes from the session-start hook (CI's headless shell).
4. If the session recorded the evals: the free replay passed inside step 2.

## 2. Review the diff

Run `/code-review` on the branch; add `/security-review` when the change touches auth, permissions, tenancy (RLS), tool arguments, or anything an outsider's text reaches. Fix what is real; say why for what is not.

## 3. Docs (only these)

- `docs/plan/STATUS.md`: the session into "Last sessions" (drop the oldest), "In progress" cleared, decisions into "Recent decisions", the planned sessions table updated.
- The ADR if a decision was made ("Accepted" and its results), `docs/plan/ai-budget.md` if the real model was called, `docs/plan/traceability.md` if acceptance criteria changed, and the area doc whose behaviour changed.
- `docs/plan/session-log.md`: a short entry (5 to 10 lines: built, checks with counts, carried items, links to the ADR and PR). `docs/plan/decisions.md`: only the user's chat decisions that no ADR holds.

## 4. PR, once (an "a" half stops before this)

An "a" half (CLAUDE.md, split sessions): STATUS "In progress" says what "b" does next; push the branch (no PR) and go to step 5 with a prompt that names the branch.

All commits in (docs included). Then open the PR (the repo's template if there is one; no model ids), subscribe to its activity, wait for the one CI run. Green: merge (squash) and unsubscribe. Red: fix every failure in one push.

## 5. The next session's prompt

Give the user a short prompt that starts the next row of STATUS "Planned sessions" with `/session-brief`.
