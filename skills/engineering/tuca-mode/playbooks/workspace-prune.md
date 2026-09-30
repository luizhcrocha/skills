# Workspace prune

**You own the safety gate. Remove only finished workspaces, only on Luiz's yes.** Deletion is on the pause list, and there is no review to catch a slip, so the checks below are the review. The `fleet ws prune` command (docs/tstack-plan.md, fleet step 2) does not exist yet: this playbook runs its checks by hand and says so in the reply.

1. List every workspace: `jj workspace list` from the main workspace, with each one's directory (`jj workspace root --name <ws>` or the path its `.jj/repo` points from). Paths come from jj, never typed by hand.
2. Run every check per workspace. A workspace is a candidate only when all hold:
   - Not `default`, not a landing workspace (`*-land`, `deploy`), not one Luiz marked protected.
   - No running worker on it: `fleets.py list` and `fleets.py show <fleet>` from the coordinator's scripts show no live lane there.
   - No heartbeat in 20 minutes (the fleet heartbeat does not exist yet: use the newest mtime under the directory, `.jj` excluded).
   - No process with its cwd inside: `readlink /proc/*/cwd` matched against the directory.
   - No uncommitted work: inside it, `jj workspace update-stale` then `jj status` shows an empty `@`.
   - Nothing unlanded: after `jj git fetch`, `jj log -r '(::<ws>@ ~ ::trunk()) ~ empty()'` is empty.
   - Idle for 2 hours by the same mtime.
   Fan the reads out to a Sonnet subagent when there are many workspaces; keep the table.
3. Dry run: show one table, a row per workspace with each check's result and the verdict (remove, keep with the failing check, archive). Unlanded work of an abandoned lane is not dropped: it becomes a local, never-pushed bookmark `archive/<fleet>/<lane>` on its head. Archive bookmarks older than 30 days appear in the table too.
4. Ask once (`AskUserQuestion`) with the exact set. Only Luiz's yes goes on; a partial yes covers only what he named.
5. For each confirmed workspace: `jj bookmark create archive/<fleet>/<lane> -r <head>` when it has unlanded work, `jj workspace forget <ws>`, remove the directory, and `jj clean` for the empty `@` left behind. Re-list and show the result.

**Reply:** the table (removed, archived, kept and the check that kept each), the commands run, and a line saying the checks ran by hand because `fleet ws prune` is not built yet.
