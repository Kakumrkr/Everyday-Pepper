---
name: session-close
description: Close a Pepper session - the full checks once and in order, a review of the diff, the four docs, one PR, one green CI run, merge, and the next session's prompt. Use when a session's tasks are done, or when the user says to wrap up, open the PR or merge.
---

# Closing a session (M2 + P1, user-approved workflow)

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

## 2. Product walkthrough (P1; any session that changed a screen, a flow or an email)

Run the app (`run` skill, or the e2e stack above) and use the changed flow **as the person it is for** (a new owner, a staff member, a client), on a 375 px phone in light and dark, plus 1280 px for signed-in screens. Save screenshots to `<scratchpad>/walkthrough/` and attach the key ones to the PR body. Tick `docs/design/DESIGN.md` §7's checklist; anything that fails is fixed now or named in the PR as a known gap. A session that changed no screen says so in one line.

## 3. Review the diff

Run `/code-review` on the branch; add `/security-review` when the change touches auth, permissions, tenancy (RLS), tool arguments, or anything an outsider's text reaches. Fix what is real; say why for what is not.

## 4. Docs (only these)

- `docs/plan/STATUS.md`: the session into "Last sessions" (drop the oldest), "In progress" cleared, decisions into "Recent decisions", the planned sessions table updated.
- The ADR if a decision was made ("Accepted" and its results), `docs/plan/ai-budget.md` if the real model was called, `docs/plan/traceability.md` if acceptance criteria changed, and the area doc whose behaviour changed.
- `docs/plan/session-log.md`: a short entry (5 to 10 lines: built, checks with counts, carried items, links to the ADR and PR), ending with a **Retro** of three lines: _went well_ · _do better_ · _top-up for the next session_. `docs/plan/decisions.md`: only the user's chat decisions that no ADR holds.
- **A phase's last session** also scores every category in `docs/plan/scorecard.md` (§4 history row, with the evidence in the session-log entry). A category under its §2 target is named in the PR and becomes the next brief's first task.

## 5. PR, once (an "a" half stops before this)

An "a" half (CLAUDE.md, split sessions): STATUS "In progress" says what "b" does next; push the branch (no PR) and go to step 6 with a prompt that names the branch.

All commits in (docs included). Then open the PR (the repo's template if there is one; no model ids; the walkthrough screenshots), subscribe to its activity, wait for the one CI run. Green: merge (squash) and unsubscribe. Red: fix every failure in one push.

After the merge, **hand the merged "a" branch of a split session to the user to delete**. GitHub's auto-delete removes only the PR's own head branch, which left S32a, S36a, S37a and S38a behind until P1. A session can't delete another branch: the git proxy refuses (403) and the GitHub tools have no branch delete. So check `git merge-base --is-ancestor origin/<a-branch> <the merged PR's head>`, then give the user the branch name, the PR it is in, and the link `https://github.com/kakumaniramakrishnarao/Everyday-Pepper/branches` (the bin icon on its row).

## 6. The next session's prompt

Give the user a short prompt that starts the next row of STATUS "Planned sessions" with `/session-brief`, and carries the retro's top-up in one line.
