---
name: session-brief
description: Start a Pepper session - read the planning docs through an Explore agent and present the Session Brief from CLAUDE.md, without loading the long docs into the main context. Use at the start of every session, when the user asks for the Session Brief or says "read CLAUDE.md and STATUS and continue".
---

# Session brief (M2, user-approved workflow)

The main context is the session's scarcest resource: reading every planning doc into it is what made S31 compact. Read the short files yourself and send an Explore agent for the long ones.

0. **A "b" half** (its prompt names the "a" branch): `git fetch origin <a-branch> && git merge origin/<a-branch>` into this session's branch first, and read STATUS "In progress" from that merge.
1. **Read yourself** (short, needed word for word): `CLAUDE.md` (already loaded) and `docs/plan/STATUS.md`. Take the target from STATUS "In progress" if it is not empty, else from the first row of "Planned sessions", unless the user names another.
2. **Send one Explore agent** (medium breadth) with the target and these questions. Ask for at most 60 lines back, with file paths and line numbers, no file dumps:
   - `docs/plan/roadmap-phases.md` and the current phase playbook: what this session must deliver, its AC IDs and gates;
   - `docs/plan/dependency-map.md`: the parts this target touches;
   - the area docs (`docs/architecture/*`, `docs/product/*`) and the latest ADRs this target builds on: the rules it must keep;
   - the code it will change: the files, the existing functions to reuse, the tests next to them;
   - `docs/plan/session-log.md` only for the last session's "Not done / for later" items.
3. **Present the Session Brief** in the CLAUDE.md format. Under "Tasks", give each task its test **tier** (see CLAUDE.md "Running tests"). If the session records the real model, say whether it is the "a" (build) or "b" (record) half.
4. **Wait for the user's OK.** Then write the plan into STATUS "In progress" with the first checkpoint.

Do not open `session-log.md` or `decisions.md` in full; ask the agent for the lines you need.
