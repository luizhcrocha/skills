# Workspace prune

**You own the safety gate. Remove only finished jj workspaces, only on Luiz's yes.** Deletion pauses, and these checks are the review.

1. `jj workspace list` from the main workspace, each with its directory (`jj workspace root --name <ws>`). Paths come from jj, never typed.
2. A workspace is a candidate only when all hold:
   - Not `default`, not a landing workspace (`*-land`, `deploy`), not one Luiz protected.
   - No live worker (`fleet ls`) and no process with its cwd inside (`readlink /proc/*/cwd`).
   - No uncommitted work: inside it, `jj workspace update-stale`, then `jj status` shows an empty `@`.
   - Nothing unlanded: after `jj git fetch`, `jj log -r '(::<ws>@ ~ ::trunk()) ~ empty()'` is empty.
   - Idle 2 hours: the newest mtime under it, `.jj` excluded.
   Many workspaces → a Reader subagent does the reads (`docs/models.md`).
3. Dry run: one table, a row per workspace with each check and the verdict (remove, keep with the failing check, archive). Unlanded work of an abandoned lane becomes a local bookmark `archive/<lane>` on its head, never pushed.
4. Ask once with the exact set. A partial yes covers only what he named.
5. Per confirmed workspace: the archive bookmark if needed, `jj workspace forget <ws>`, remove the directory. Re-list and show the result.

**Reply:** the table (removed, archived, kept and why), and the commands run.
