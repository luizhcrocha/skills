---
description: "Strip narrating comments from a diff and fix what they papered over. Use before landing, or for \"no comments\", \"deslop the comments\"."
disable-model-invocation: ~
---

- The agent is `tstack:comment-sicko` (Agent tool, `subagent_type: tstack:comment-sicko`).
- The default scope is the stack about to land, `jj diff -r '<landing bookmark>@origin..@'`, or `@` alone. A rejected report's deletions come back with `jj restore`.
- Check a thin `IMPORTANT` or `do not remove` comment with `tstack:how` or `tstack:why` on its symbol.
- A CI lint, or a `MUST KILL` a linter could catch, goes through `tstack:correct`. Deletions stay in the working copy for `tstack:worktree-janitor`.
- Every comment gets one category and its action: **Tautology** (repeats the code) and **Stale** (names code or behaviour that is gone, or cites an ADR: no repo keeps them): delete. **Excuse** (lets a hack stand): delete, and file an issue to fix the hack (`tstack:triage`). **Decision Record** (a non-obvious decision): move it into a memo note (`tstack:memo`) or the change's description, then delete.
- Then ban comments in the scope with a lint rule through `tstack:correct`, as a ratchet: today's survivors are baselined, a new comment fails. Report how many lines deleting every remaining comment would shed.
