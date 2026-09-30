---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd (`tstack:tdd`) where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use `tstack:review` to review the work.

Record your work as jj changes on the current stack: each finished unit gets `jj describe -m "<message>"` in the repo's style (`jj log` shows it), then `jj new`, so `@` ends empty. When `@` holds several intents at the end, run `/tstack:worktree-janitor` to split and describe them instead. Pushing belongs to the Land playbook (`/tuca-mode`) or the user. In a plain git repo, commit to the current branch.
