---
description: "Strip narrating comments from a diff and fix what they papered over. Use before landing, or for \"no comments\", \"deslop the comments\"."
disable-model-invocation: ~
---

- The agent is `tstack:comment-sicko` (Agent tool, `subagent_type: tstack:comment-sicko`).
- The default scope is the stack about to land, `jj diff -r '<landing bookmark>@origin..@'`, or `@` alone. A rejected report's deletions come back with `jj restore`.
- Check a thin `IMPORTANT` or `do not remove` comment with `tstack:how` or `tstack:why` on its symbol. A fix that needs a shape is sketched with `tstack:codebase-design`, not `/architect`.
- A CI lint, or a `MUST KILL` a linter could catch, goes through `tstack:lint-evolve`. Deletions stay in the working copy for `tstack:worktree-janitor`.
