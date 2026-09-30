# Land

**You own what reaches the landing bookmark. Shape the stack, prove it, push it.** The default end of every playbook that changes code. A pull request is a different road (Shipping), taken only when Luiz asks for one.

1. Name the landing bookmark from the repo's own docs (`CLAUDE.md`, `AGENTS.md`, `README.md`, the justfile): `master` in most repos, `nix` in dotfiles. Docs silent → `jj bookmark list` and `trunk()`; still ambiguous → ask. Luiz said "leave it for me to land" → do steps 2 to 4, then stop and report the change ids.
2. Take the landing turn. In a fleet, landing happens from the landing workspace (`*-land`, `deploy`), one turn at a time; `default` is Luiz's. `jj git fetch`, then bring the stack onto the fresh tip when it moved: `jj rebase -s <stack root> -d <bookmark>@origin`. Conflicts are resolved in the stack, by intent.
3. Shape the stack with `/tstack:worktree-janitor` (the skill spawns the agent and audits it): split by intent, fixups absorbed, repo-style descriptions, empty `@` on top. Pass the session's `Claude-Session:` trailer when the repo's messages carry one. Done when its audit passes.
4. Run the repo's checks on the stack head, as the repo names them (`just test`, `just validate`, the package scripts, the CI config's commands); per-revision checks through the janitor's `--check` when each change must stand alone. Red → fix in the owning change (`jj squash --into` or `jj absorb`), then re-run from step 3.
5. Push, fast-forward only. `jj log -r '<bookmark>@origin..<head>'` shows exactly the stack; `<bookmark>@origin` is an ancestor of the head. Then `jj bookmark set <bookmark> -r <head>` and `jj git push --bookmark <bookmark>`. A push that would rewrite remote history (not a descendant, `--allow-backwards`, a force) is on the pause list: stop and ask. The push goes over SSH through 1Password, which waits for a click; when it stalls, say so and leave the command for Luiz.
6. Confirm: `jj log -r '<bookmark>@origin'` is your head. `@` sits on a fresh empty change (`jj new` if `@` is the pushed commit). Memo notes written during the work land with it.

**Reply:** the bookmark, the landed change ids with their subjects, the checks run and their result, the janitor's audit verdict and undo line, and anything left out of the landing.
