---
name: tuca-mode
description: "Luiz's working style: pstack's poteto-mode plus his changes (jj, fleet, Rex, models.md roles). Use for /tuca-mode, or requests to work in this style."
---

1. Named skills are tstack's; starting tuca-mode opts in to them: Glob `<plugin root>/skills/*/<name>/SKILL.md` (the root holds `local/`), read and follow it. Leaf `principle-<title>` is `skills/engineering/principles/<title>.md`.
2. History is jj (`tstack:jj`): a worktree is a workspace (`ws-add`), a branch a bookmark. A force-push still pauses.
3. Code work ends with [Land](tuca-mode/land.md), a bookmark push; a PR (Opening a PR, Babysit, Shipping) only when Luiz asks. A break blocking others or production → [Hotfix](tuca-mode/hotfix.md) first. Finished workspaces → [Workspace prune](tuca-mode/workspace-prune.md).
4. Model and effort: the role's in [docs/models.md](../docs/models.md), over Subagents' slugs and Fable rule; pass both. Delegates are `tstack:tuca-agent`.
5. Reach Luiz without a dialog: fleet's fences (```bash fleet:run, ```text fleet:grant, ```text fleet:ask; its session note). A run's fence holds the command itself, unlabeled; then copies: nushell for his terminal (`tstack:lang-nu`) and `bash ~/.run/<name>.sh` in a ```bash script fence, for any shell. A refused call reaches his inbox by itself; never retry or reword it. A fleet:ask's options are numbered (`- 1. label: what it changes`), so he can answer "1".
6. Suites and heavy checks: `fleet test`, `fleet run --`; a run Luiz watches: a Rex tab (`fleet tab run`); the rest: background Bash. Waits are events, never sleep loops. A `block:<uuid>` from Luiz → `rex-watch`.
7. Near 200k context, at a quiet point, a session Luiz started runs Pause safely (`tstack:handoff`) and asks him to restart from it.
8. Before a decision costly to undo, get one ruling from a Fable agent; reply with both rulings.
9. Another's error goes to its owner the same turn: `fleet msg ask <owner> "<line, where, since when>"`.
10. Deploys and restarts: asked once, at the task, batched across the app's agents. Messages to people (issues, PR comments, chat) pause for his yes.
11. Your leftovers (landed workspaces, servers, watchers, scratch) go unasked. Done → say so; offer heads-up's cleanup and suspend.
12. "stop tuca-mode" → drop these rules.
13. Event order where a break costs money, data or permissions → suggest `/create-formal-verification-skill` once per target; Luiz starts it.
