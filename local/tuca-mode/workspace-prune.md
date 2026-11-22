# Workspace prune

**Your own finished workspace goes unasked, with `ws-rm <name>`. A sweep of the rest removes only on Luiz's yes.** `ws-rm` holds the safety gate in code: it refuses a workspace outside `.ws/<repo>/`, `default` and landing workspaces (`*-land`, `deploy`), one with a process inside, and one holding a non-empty commit `trunk()` lacks, after snapshotting it. Luiz's settings allow `ws-rm *`, so run it bare, from outside the workspace, never behind `cd … &&`.

## Your own

After your work lands (Land step 7) or is abandoned on purpose (`jj abandon`), run `ws-rm <name>`. A refusal names the check: fix the cause (land, abandon, leave the folder) or leave it for the sweep. Never fall back to `jj workspace forget` and `rm -rf`. A session running inside its workspace (a fork-tab) leaves it: fleet removes it when it ends that agent.

## The sweep

1. `jj workspace list` from the main workspace, each with its directory (`jj workspace root --name <ws>`). Paths come from jj, never typed.
2. A workspace is a candidate only when all hold:
   - Not one Luiz protected, and no live worker (`fleet ls`).
   - Idle 2 hours: the newest mtime under it, `.jj` excluded.
   - `ws-rm` would pass it: under `.ws/<repo>/`, no process inside, and after `jj git fetch` and a snapshot (`jj workspace update-stale`, `jj status` inside it) every commit of `(::<ws>@ ~ ::trunk()) ~ empty()` is a landed copy: `git cherry <trunk()> <ws>@` (commit ids) marks it `-`, its patch already on trunk. Matching subjects is not enough: a fix round relands a different patch under the same first line.
   Many workspaces → a Reader subagent does the reads (`docs/models.md`).
3. Dry run: one table, a row per workspace with each check and the verdict (remove, keep with the failing check, archive). Unlanded work of an abandoned lane becomes a local bookmark `archive/<lane>` on its head, never pushed. Legacy workspaces outside `.ws/` (`../<repo>-<slug>`) appear here too.
4. Ask once with the exact set. A partial yes covers only what he named.
5. Per confirmed workspace: `ws-rm <ws>`. One `ws-rm` refuses (archived, or outside `.ws/`): the archive bookmark if needed, `jj workspace forget <ws>`, remove the directory; his yes covers that prompt. Re-list and show the result.

**Reply:** the table (removed, archived, kept and why), and the commands run.
