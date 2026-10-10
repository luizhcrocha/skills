---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd (`tstack:tdd`) where possible, at pre-agreed seams.

Run typechecking and the test files you touch regularly. At the end, run only the tests the change touches: the repo's scoped command when it has one (tstack: `just test-changed`; elsewhere the scoped run AGENTS.md or CLAUDE.md names, else the test files beside the changed modules or the package's own suite), plus the suites for the code you changed. Rerun a load timeout alone. When the full gate is the repo's only test entry point, run the narrowest command the tooling allows (vitest with a file filter, pytest with a path, `go test ./pkg/...`, `cargo test -p <crate>`). Say what you ran. The repo's full gate runs once, in the session that lands (the Land playbook), not here: measured on 2026-10-09, workers spent 86% of their wall time waiting on tools, mostly full gates of 13 minutes and more.

Once done, use `tstack:review` to review the work.

Record your work as jj changes on the current stack: each finished unit gets `jj describe -m "<message>"` in the repo's style (`jj log` shows it), then `jj new`, so `@` ends empty. When `@` holds several intents at the end, run `/tstack:worktree-janitor` to split and describe them instead. Pushing belongs to the Land playbook (`/tuca-mode`) or the user. In a plain git repo, commit to the current branch.
