# Workspace prune

**You own the safety gate. Remove only finished workspaces, only on Luiz's yes.** Deletion is on the pause list, and there is no review to catch a slip, so the checks below are the review. Workspaces a fleet made (`fleet ws add`) go through `fleet ws <dashboard-dir> prune`: it runs these checks itself, its default is the dry run (step 3), and `--apply` is step 5 after Luiz's yes. A coordinator prunes its own as it integrates each worker (or hands the workspace to the lane's next worker with `--reuse`), so this playbook is for the pile those runs left behind: every other workspace, checked by hand, as the reply says.

1. List every workspace: `jj workspace list` from the main workspace, with each one's directory (`jj workspace root --name <ws>` or the path its `.jj/repo` points from). Paths come from jj, never typed by hand.
2. Run every check per workspace. A workspace is a candidate only when all hold:
   - Not `default`, not a landing workspace (`*-land`, `deploy`), not one Luiz marked protected.
   - No running worker on it: `fleet fleets list` and `fleet fleets show <fleet>` show no live lane there.
   - No heartbeat in 20 minutes: `fleet ws <dashboard-dir> list` shows when each fleet worker was last seen; elsewhere, the newest mtime under the directory, `.jj` excluded.
   - No process with its cwd inside: `readlink /proc/*/cwd` matched against the directory.
   - No uncommitted work: inside it, `jj workspace update-stale` then `jj status` shows an empty `@`.
   - Nothing unlanded: after `jj git fetch`, `jj log -r '(::<ws>@ ~ ::trunk()) ~ empty()'` is empty.
   - Idle for 2 hours by the same mtime.
   Fan the reads out to a Reader subagent ([MODELS.md](../../../productivity/coordinator/MODELS.md)) when there are many workspaces; keep the table.
3. Dry run: show one table, a row per workspace with each check's result and the verdict (remove, keep with the failing check, archive). Unlanded work of an abandoned lane is not dropped: it becomes a local, never-pushed bookmark `archive/<fleet>/<lane>` on its head. Archive bookmarks older than 30 days appear in the table too.
4. Ask once with the exact set (a decision on the fleet's page when the session serves one, else `AskUserQuestion`). Only Luiz's yes goes on; a partial yes covers only what he named.
5. For each confirmed workspace: `jj bookmark create archive/<fleet>/<lane> -r <head>` when it has unlanded work, `jj workspace forget <ws>`, remove the directory, and `jj clean` for the empty `@` left behind. Re-list and show the result.

**Reply:** the table (removed, archived, kept and the check that kept each), the commands run, and for workspaces outside a fleet's ledger a line saying the checks ran by hand.
