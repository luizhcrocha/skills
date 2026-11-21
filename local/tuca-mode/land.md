# Land

**You own what reaches the landing bookmark. Shape the stack, prove it, push it.** The default end of every playbook that changes code. A pull request (Opening a PR, Shipping) only when Luiz asks for one. A fix for a break that blocks others lands first, on its own: [Hotfix](hotfix.md).

1. Name the landing bookmark from the repo's docs (`AGENTS.md`, `CLAUDE.md`, `README.md`, the justfile): `master` in most repos. Docs silent → `jj bookmark list` and `trunk()`; still ambiguous → ask. "Leave it for me to land" → steps 2 and 3, then stop and report the change ids.
2. Land from your own workspace, never `default` (Luiz's). `jj git fetch`, then `jj rebase -b @ -d <bookmark>@origin`. Resolve conflicts in the stack, by intent.
3. `tstack:no-comments` on the stack's diff, then `tstack:worktree-janitor`: split by intent, fixups absorbed, repo-style descriptions, empty `@` on top. No `Claude-Session:` or other attribution trailer: the push hook refuses one (D585). Done when its audit passes.
4. `land-check -b <bookmark>` says `gate_needed: false` (docs only) → step 5. Otherwise run the repo's full gate once, on the rebased stack head (tstack: `just test`; elsewhere the package scripts or CI's commands). Workers ran only their scoped tests; this is the one full run. With `fleet` on PATH it runs as `fleet land --gate -b <bookmark> -- <gate>` (its `--help` says how it queues and holds; a refusal, an ejection or another non-zero exit → `fleet:pool-land`; a proof or run placed on the pool → `fleet:pool-run`); without, `land-check --pre-gate -b <bookmark>` then the gate. A red → the fix goes to the change that caused it (`jj squash --into`, `jj absorb`), then from step 3. A red in code the stack does not touch still stops the land: tell its owner and Luiz.
5. `land-check --bookmark <bookmark> --apply-skip-ci` gives the verdict:
   - `push` → step 6.
   - `ask` → the push would deploy, or nobody can tell: ask Luiz, with `jj log -r '<bookmark>@origin..<head>'` and the `reasons`.
   - `stop` with `freeze` → another landing holds the repo: wait the time named, then step 2 again (step 4 too if the rebase moved the stack). After your own `fleet land --gate` passed, pass `--push-token <token>`.
   - `stop` → several heads (ask which, or join them), not a fast-forward (a force-push pauses for Luiz), or an undescribed or conflicted revision (step 3).
6. `fleet land` exited 0 → it already pushed the stack: never push it again by hand (`fleet:pool-land`). Otherwise `jj bookmark set <bookmark> -r <head>`, `jj git push --bookmark <bookmark>`. A push stalled on 1Password → ask Luiz to approve it, then push again. Free a `fleet land` token (`fleet gate free <token>`). Then `memo sync` (when on PATH) and `tstack:unblock` for the sessions waiting on this landing.
7. Confirm `jj log -r '<bookmark>@origin'` is your head, and `@` is a fresh empty change (`jj new`). A workspace you made for this work and do not run inside: `ws-rm <name>`.
8. The work came from a fork-tab handoff with a `next` line → follow it: open that piece with `tstack:fork-tab` from the handoff file it names; its `waits` line holds it until the other pieces it waits on land.

**Reply:** the bookmark, the landed change ids with subjects, the checks and their result, the janitor's verdict, land-check's verdict and deploy finding, `[skip ci]` if added, the next piece opened if any, and anything left out.
