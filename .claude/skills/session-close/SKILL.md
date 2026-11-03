---
name: session-close
description: Close a Pepper session with scope-appropriate checks, review, walkthrough when relevant, concise shared records, the existing PR/merge workflow, and a next-session handoff. Use when tasks are done or the user asks to wrap up.
---

# Closing a session (M2 + P1; PCR-008 and PCR-009)

**Order matters: review before final checks.** S41 ran the full Playwright suite three times after late fixes. Review and fix first, then run each applicable final suite once; revalidate broader scope only when new changes or findings justify it.

Every local full suite runs alone, never two side by side (they starve each other and time out). Long runs go in the background (`run_in_background`), output to `<scratchpad>/<name>.log`; read the summary and relevant failures rather than dumping passing logs. Use the check-selection matrix in `docs/engineering/testing-strategy.md` as the maintained source for scope decisions.

## 1. Review the diff (first)

For code changes, run `/code-review` on the branch; add `/security-review` when the change touches auth, permissions, tenancy (RLS), tool arguments, or anything an outsider's text reaches. Fix what is real; say why for what is not. After fixes, run tier 2 and affected tests only. Do not repeat an already-passed targeted check at the same checkpoint when its code, dependencies, fixtures, configuration and relevant environment are unchanged; record the evidence reused. The required final code-change run below remains mandatory.

For prose/planning-only work, review the actual diff and cross-document consistency directly. Workflow/skill instruction edits need a review of check coverage, failure handling and authorization boundaries; validate edited skills with an available validator. Do not invoke unrelated design or application review workflows merely because they are installed.

## 2. Checks, once, in this order

**Classify the final diff first, including intended new files.** For non-runtime prose/planning/workflow Markdown only: run whitespace/diff checks, affected relative-link checks, acceptance-ID/reference consistency where relevant, and the review above. No application build, Docker stack, integration or browser suite is required when none consumes the changed material. Say which checks were not applicable and why. Runtime-loaded prompts/templates, code, fixtures, configuration, lockfiles and executable scripts use the normal code-change path even if a file is text/Markdown. Mixed or uncertain changes use the code-change path.

For code changes:

1. `pnpm check` (format, lint, typecheck, unit tests with coverage, build).
2. The integration tests of the packages the change can affect, alone: `TURBO_SCM_BASE=origin/main pnpm turbo run test:integration --affected` (changed packages and their dependents; nothing for a screens-only session). CI runs every package on the PR.
3. Playwright, alone, only if a screen or flow changed: the specs of the changed screens and flows, plus `screens.spec.ts` when a screen changed (its baselines). CI runs the full suite.
   ```sh
   .claude/skills/session-close/e2e-stack.sh start <scratchpad>   # after pnpm check: it uses the build
   pnpm --filter @pepper/e2e test:e2e --workers=3 tests/<spec>.ts …
   .claude/skills/session-close/e2e-stack.sh stop
   ```
   **The full suites run once, in CI, inside this session** (user, 2026-11-03): step 5.
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE` comes from the session-start hook (CI's headless shell).
4. If the session recorded the evals: the free replay passed inside step 2.

**A red step:** fix it, re-run the affected failing cases (the file, or `test:e2e tests/<spec>.ts`), then go on. A fix that touches another area also runs tier 2 and relevant regressions there. Do not repeat the whole suite merely to recheck the same failure; broaden validation when the fix or new evidence broadens the affected scope. CI's required suites remain unchanged.

If a check fails again without an explanatory change, inspect its failure and isolate the cause instead of repeating unchanged full runs. A reproduction attempt is diagnostic evidence, not a fix; retain unresolved failures and their logs. Never make a gate pass by increasing tolerances, shrinking meaningful fixtures, disabling cases, or retrying away instability. Full revalidation beyond the normal close is justified when new changes or findings broaden the affected scope.

Keep one valid E2E stack alive for related targeted runs; rebuild/restart when changed inputs require it. Use the helper and existing Turborepo cache rather than repeatedly rebuilding Docker app images in cloud sessions. Do not remove build prerequisites without verifying which outputs the test process imports.

**Screenshot baselines:** when a screenshot test fails because the screen changed on purpose, look at the new image, then `--update-snapshots` that spec and run it once more (a second run shows it is stable).

## 3. Product walkthrough (P1; any session that changed a screen, a flow or an email)

The screenshot spec already shows each changed screen at 375/412/1280 px in light and dark (`e2e/tests/__screenshots__/`): look at those images instead of taking them again by hand. Then walk **one** changed flow as the person it is for (a new owner, a staff member, a client), at 375 px in one theme, with a short Playwright script or the `run` skill; screenshots go to `<scratchpad>/walkthrough/`. Tick `docs/design/DESIGN.md` §7's checklist; anything that fails is fixed now or named in the PR as a known gap. A session that changed no screen says so in one line.

## 4. Docs (only these)

- `docs/plan/STATUS.md`: the session into "Last sessions" (drop the oldest; 3–4 lines), "In progress" cleared, one line in "Recent decisions" linking `decisions.md`, the planned sessions table updated.
- `docs/plan/decisions.md`: the user's chat decisions that no ADR holds, in full (the one place they are written out).
- `docs/plan/session-log.md`: a short entry (5 to 10 lines: built, checks with counts, carried items, links to the ADR and PR), ending with a **Retro** of three lines: _went well_ · _do better_ · _top-up for the next session_.
- The ADR if a decision was made ("Accepted" and its results), `docs/plan/ai-budget.md` if the real model was called, `docs/plan/traceability.md` if acceptance criteria changed, and the area doc whose behaviour changed.
- **A phase's last session** also scores every category in `docs/plan/scorecard.md` (§4 history row, with the evidence in the session-log entry). A category under its §2 target is named in the PR and becomes the next brief's first task.

Use one existing session-log entry; do not create a new session report, checklist or handoff file. Add one compact timing line from existing logs: setup/build, targeted checks, final suites, walkthrough/rework, CI execution and waiting where available. Mark unmeasured time as unknown; do not run checks again to collect timings. The next target stays in the playbook/STATUS. Create a PCR only for an actual approved-plan/contract change and an ADR only for an architectural decision.

## 5. PR, once, and its CI inside the session (an "a" half stops before this)

An "a" half (CLAUDE.md, split sessions): STATUS "In progress" says what "b" does next; push the branch (no PR) and go to step 6 with a prompt that names the branch.

1. Every code commit in (steps 1–3 green, the walkthrough's fixes made), then open the PR (the repo's template if there is one; no model ids; the walkthrough screenshots or the baselines' paths) and subscribe to its activity.
2. **While CI runs** (about 12 minutes), write step 4's docs locally and commit them; do not push yet (a push now would cancel the run).
3. **Green:** push the docs commit. A push of docs only on top of a green head skips the jobs (`ci.yml`), so its run finishes in a minute; then merge (squash) and unsubscribe.
4. **Red: fixed in this session, never handed to the next.** Read the failing job's log, find the root cause (compare with the last green run's timings and with `main`: a test that is slow everywhere is a test problem, a failure only here is this change's), fix it with a test that shows it, run that check locally, and push the fix together with the docs in one push. Never re-run to get green, raise an assertion threshold, skip or quarantine a test; a time cap below ~3× a test's measured time is a test problem (testing-strategy.md).

After the merge, **hand the merged "a" branch of a split session to the user to delete**. GitHub's auto-delete removes only the PR's own head branch, which left S32a, S36a, S37a and S38a behind until P1. A session can't delete another branch: the git proxy refuses (403) and the GitHub tools have no branch delete. So check `git merge-base --is-ancestor origin/<a-branch> <the merged PR's head>`, then give the user the branch name, the PR it is in, and the link `https://github.com/kakumaniramakrishnarao/Everyday-Pepper/branches` (the bin icon on its row).

## 6. The next session's prompt

Give the user a short prompt that starts the next row of STATUS "Planned sessions" with `/session-brief`, and carries the retro's top-up in one line.
