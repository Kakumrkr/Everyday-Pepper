---
name: session-close
description: Close a Pepper session - review first, then the full checks once and in order, the walkthrough, the docs, one PR, one green CI run, merge, and the next session's prompt. Use when a session's tasks are done, or when the user says to wrap up, open the PR or merge.
---

# Closing a session (M2 + P1, user-approved workflow; made faster in PCR-008)

**Order matters: review before checks.** A fix after the checks sends every suite round again (S41 ran the full Playwright suite three times that way). So the review and its fixes come first, and each suite then runs **once**.

Every suite runs alone, never two side by side (they starve each other and time out). Long runs go in the background (`run_in_background`), output to `<scratchpad>/<name>.log`; read only the summary lines (`tail`, `grep -E "passed|failed|✘"`), and the failure itself only if there is one.

## 1. Review the diff (first)

Run `/code-review` on the branch; add `/security-review` when the change touches auth, permissions, tenancy (RLS), tool arguments, or anything an outsider's text reaches. Fix what is real; say why for what is not. After the fixes, run tier 2 only (typecheck and lint of what changed, the changed packages' unit tests) and the Playwright spec of any screen a fix touched.

## 2. Checks, once, in this order

1. `pnpm check` (format, lint, typecheck, unit tests with coverage, build).
2. `pnpm test:integration`, alone: **only when the session changed code the integration tests run** (anything under `packages/` except `packages/ui`, or `apps/api`, `apps/worker`, or a migration). A screens-only session (`apps/web`, `packages/ui`, `e2e`, docs) skips it and says so in the PR: CI runs it on the PR anyway.
3. Playwright, alone, only if a screen or flow changed: the full suite, once.
   ```sh
   .claude/skills/session-close/e2e-stack.sh start <scratchpad>   # after pnpm check: it uses the build
   pnpm --filter @pepper/e2e test:e2e --workers=3
   .claude/skills/session-close/e2e-stack.sh stop
   ```
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE` comes from the session-start hook (CI's headless shell).
4. If the session recorded the evals: the free replay passed inside step 2.

**A red step:** fix it, re-run **only the failing tests** (the file, or `test:e2e tests/<spec>.ts`), then go on to the next step. Do not re-run the whole suite: CI runs every suite once on the PR. A fix that touches code outside the failing test's area also re-runs tier 2 of what it touched.

**Screenshot baselines:** when a screenshot test fails because the screen changed on purpose, look at the new image, then `--update-snapshots` that spec and run it once more (a second run shows it is stable).

## 3. Product walkthrough (P1; any session that changed a screen, a flow or an email)

The screenshot spec already shows each changed screen at 375/412/1280 px in light and dark (`e2e/tests/__screenshots__/`): look at those images instead of taking them again by hand. Then walk **one** changed flow as the person it is for (a new owner, a staff member, a client), at 375 px in one theme, with a short Playwright script or the `run` skill; screenshots go to `<scratchpad>/walkthrough/`. Tick `docs/design/DESIGN.md` §7's checklist; anything that fails is fixed now or named in the PR as a known gap. A session that changed no screen says so in one line.

## 4. Docs (only these)

- `docs/plan/STATUS.md`: the session into "Last sessions" (drop the oldest; 3–4 lines), "In progress" cleared, one line in "Recent decisions" linking `decisions.md`, the planned sessions table updated.
- `docs/plan/decisions.md`: the user's chat decisions that no ADR holds, in full (the one place they are written out).
- `docs/plan/session-log.md`: a short entry (5 to 10 lines: built, checks with counts, carried items, links to the ADR and PR), ending with a **Retro** of three lines: _went well_ · _do better_ · _top-up for the next session_.
- The ADR if a decision was made ("Accepted" and its results), `docs/plan/ai-budget.md` if the real model was called, `docs/plan/traceability.md` if acceptance criteria changed, and the area doc whose behaviour changed.
- **A phase's last session** also scores every category in `docs/plan/scorecard.md` (§4 history row, with the evidence in the session-log entry). A category under its §2 target is named in the PR and becomes the next brief's first task.

## 5. PR, once (an "a" half stops before this)

An "a" half (CLAUDE.md, split sessions): STATUS "In progress" says what "b" does next; push the branch (no PR) and go to step 6 with a prompt that names the branch.

All commits in (docs included). Then open the PR (the repo's template if there is one; no model ids; the walkthrough screenshots or the baselines' paths), subscribe to its activity, wait for the one CI run. Green: merge (squash) and unsubscribe. Red: fix every failure in one push.

After the merge, **hand the merged "a" branch of a split session to the user to delete**. GitHub's auto-delete removes only the PR's own head branch, which left S32a, S36a, S37a and S38a behind until P1. A session can't delete another branch: the git proxy refuses (403) and the GitHub tools have no branch delete. So check `git merge-base --is-ancestor origin/<a-branch> <the merged PR's head>`, then give the user the branch name, the PR it is in, and the link `https://github.com/kakumaniramakrishnarao/Everyday-Pepper/branches` (the bin icon on its row).

## 6. The next session's prompt

Give the user a short prompt that starts the next row of STATUS "Planned sessions" with `/session-brief`, and carries the retro's top-up in one line.
