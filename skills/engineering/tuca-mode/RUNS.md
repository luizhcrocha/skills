# Runs

tuca-mode's rules for a run, yours or a worker's: a test suite or tier, a build or heavy check, a dev server, watcher, deploy or backfill, anything over about a minute, a round of screenshots or probes. Every `fleet` command here runs only when `fleet` is on PATH; without it, the run is the command itself, as a `run_in_background` Bash call when it is long.

## Suites and heavy checks go through fleet

- A run over a whole suite or test tier, in any repo, runs through fleet, which places it and admits it on memory: `fleet test` runs the repo's `.fleet/test` (`fleet run -- <command>` in a repo without one). A build or another heavy check that is no suite is `fleet run -- <command>`. One test file or a targeted run needs no slot.
- Cap the Vitest pool: two at once ran the machine out of memory and the reaper killed every fleet's chat watch (2026-10-08 18:20).
- A landing gate's slot and its push token are in the Land playbook, step 7.

## A run waiting on memory may name idle processes to free

When a `fleet test` or `fleet run` says an orphaned group holds memory, run `fleet gate hogs`, which only reports, then `fleet gate reap`, which stops only the groups `hogs` marks `reap`: big, idle, their session dead, and every process of a kind that rebuilds itself. `fleet gate reap` has no way to stop anything else. A live owner's hog is theirs: tell the session, or ask the owner with a permission card on an exact `kill` call.

## A long run the user would watch goes in a Rex tab

A dev server, watcher, deploy, backfill or other run longer than about a minute that prints as it goes runs in a Rex tab beside the agent's, where the user can see it. A run that prints nothing until it ends (its output goes to log files, or it reports only once at the end) gains nothing from a tab: it is a `run_in_background` Bash call. Outside Rex, or without `fleet`, every run is a `run_in_background` Bash call (`fleet tab` refuses outside Rex).

- `fleet tab run --as <worker-id> --tab <purpose> --label <pane> -- <command>` prints the pane's block id. `fleet tab wait <block>`, as a `run_in_background` Bash call, exits with the command and prints its last lines.
- `--as` is the worker's own id; a coordinator gives its own. Agent-tool workers share their coordinator's tab, and the id keeps their tabs apart.
- One tab per purpose, one pane per command, at most 4 panes: a deploy and its backfill share a tab.
- The pane starts in the agent's cwd (`--cwd` for another) with the login shell's environment, not the agent's: in a devenv repo the command still takes its devenv wrapper (`devenv-run <cmd>`).
- The pane runs the command the agent would have run, so a whole suite is still `fleet test` and a build or other heavy check `fleet run -- <command>`.
- The agent closes its tab (`fleet tab close --as <worker-id> <purpose>`) when done, unless the brief says to leave it up.

## Waiting on a run

A foreground `until ... sleep` loop, `tail -f` or long timeout is not allowed; one wait under about 30 seconds is. In a fleet a Monitor command only watches: `tail -f`, `grep`, a `while`/`until` loop of read-only commands, no `$` expansion; the hook denies the rest. A command that acts is a Bash call, where auto mode judges it. Measured on 2026-10-10 over 69 fleet workers, poll loops held 3.4 hours, 36% of their Bash wait.

## A round of screenshots or probe runs is one script

It does all N and writes a summary (each path and a one-line result), lives in the agent's scratch dir, and reruns each round. The same measure found 2.9 hours, 31% of the Bash wait, spent on experiments and screenshots as 334 separate calls.
