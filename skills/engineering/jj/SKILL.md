---
name: jj
description: "jj rules for commits, pushes, PRs and undo in colocated repos, in place of Claude Code's git instructions. Use before a commit, push, PR or undo, or to look into another agent's workspace."
---

# jj

Luiz's repos are jj colocated with git. `~/.claude/CLAUDE.md` ("Version control") holds the commands, the publish flow and one workspace per agent; this skill holds the rest. A messy `@` goes to `tstack:worktree-janitor`, a conflict to `tstack:resolving-merge-conflicts`.

## Commit

- Commit when Luiz or the playbook in hand asks for it (`implement`, tuca-mode's Land).
- Read `jj st` and `jj log -n 10` first. They replace git's session-start snapshot, and since jj snapshots every file in the tree, `jj st` is where a secret (`.env`, credentials, `settings.local.json`) or build output shows up. Keep it out: add it to `.gitignore`, then `jj file untrack <path>`, and tell Luiz about any secret.
- Match the subjects in `jj log` (prefix habit, length, the `(Luiz, <date>)` tag for his decisions). End the message with the attribution trailer the session's system reminder gives.
- `jj describe -m "<message>"`, then `jj new`.

## Stay headless

An editor or diff tool hangs an agent. Pass `-m` to `describe`, `commit` and `split` (with paths), and `-m` or `-u` to a `squash` that joins two descriptions. Leave `-i`, `jj resolve`, `jj diffedit` and a pathless `jj split` to Luiz; split hunks with `jj-hunk-pick`.

## Push

- Push and move bookmarks when asked; in a fleet they belong to the landing turn.
- Read `jj log -r '<bookmark>@origin..<rev>'` first: every commit in it ships.
- `jj git push --bookmark <name>`, one bookmark by name. Bookmarks move forward only, so `--allow-backwards` and `--all` wait for Luiz.
- A conflicted bookmark (`name??`): the landing-turn holder rebases the unpublished side onto `<bookmark>@origin`, then sets the bookmark.

## GitHub

- Run `gh` from the main workspace: extra workspaces have no `.git`.
- End a PR body with the attribution line the system reminder gives.
- A bare `@name` in a PR, issue or comment notifies that GitHub user. Write it only for a real login you mean to notify; roles, placeholders and code (`` `@reviewer` ``, `` `@types/node` ``) go in backticks.

## Undo

The repo is shared by every workspace. `jj undo` reverts the newest operation, whoever ran it, and `jj op restore` rolls back every workspace's work. Undo your own with `jj op revert <op>` (your operation, from `jj op log`) or `jj restore --from <rev> <paths>`.

## Beside other agents

- Look into another workspace from your own: `jj log -r '<workspace>@'`, or `jj -R <path> --at-op=@ st`, which reads its last snapshot without taking one. A plain `jj st` run there snapshots its files into its owner's change.
- Name changes by change id in commands. A commit id pins one moment: evidence, stale after the next rewrite.
- Before rewriting a change, run `jj log -r '<rev>+::'`: describing or editing a commit someone stacked on rebases their stack under them. Tell the owner.
- Remove a workspace with `jj workspace forget <name>` before its directory, once its changes have landed or were abandoned on purpose.
