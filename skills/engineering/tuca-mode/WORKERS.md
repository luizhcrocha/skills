# Workers

tuca-mode's rules for the agents a session spawns, read before the first spawn. Runs (suites, builds, servers, tabs, probe rounds) are in [RUNS.md](RUNS.md). Every `fleet` command here runs only when `fleet` is on PATH.

## Workspace and context

- **A code-writing worker works in a jj workspace, reused along its lane.** A worker that follows another's lane takes its workspace (`fleet ws <dashboard-dir> add <worker-id> --reuse <workspace>`). A fresh one (`fleet ws <dashboard-dir> add <worker-id> -r <base>`; with no ledger yet, or no `fleet`, `jj workspace add ../<repo>-<lane> -r <base> --name <lane>`) only for parallel workers whose files could meet, a risky experiment, or an arena or swarm comparison.
- **150k tokens is the line.** A small follow-up goes back to the same worker while its context is under about 150k tokens; past that, a fresh worker takes it with the old worker's handoff in its brief. A brief bounds the reading by name. A worker that reaches 150k finishes the read, edit or test cycle in hand and starts no other, then leaves a resume point and reports. [models.md](../../../docs/models.md) has the evidence and the limits by role.

## The tests a worker runs

A worker runs only the tests its change touches, in any repo: the repo's scoped command when it has one (tstack: `just test-changed`; elsewhere the scoped run `AGENTS.md` or `CLAUDE.md` names, else the test files beside the changed modules or the package's own suite), plus the suites for the code it changed. When the full gate is the repo's only test entry point, it runs the narrowest command the tooling allows (vitest with a file filter, pytest with a path, `go test ./pkg/...`, `cargo test -p <crate>`) and names it in its report. It never runs the repo's whole gate. Measured on 2026-10-09, workers spent 86% of their wall time waiting on tools, mostly full gates of 13 minutes and more, and 14% in the model.

The worker reruns a red under load once, alone. A red its change did not cause goes to the tests fleet as news with its log path, posted by the worker. For a flake tests has already posted a finding for, cite that news id when you ask for the landing turn; the lander still proves it. A flaky red holds no land; Integrate (the fleet plugin's coordinator skill, INTEGRATE.md) says what proves one.

You run the full gate once, on the merged and rebased stack before the push (Land step 5), and send a failure back to the worker whose change caused it.

## A refused call is reported, never retried

A worker whose call auto mode refused does not repeat or reword it and takes no other route to the same act. In a fleet the hook tells the coordinator at once, who decides whether Luiz is asked, and tells the worker at its next tool call. The worker reports `blocked: <what it needed the call for>` and goes on with the work that does not need it.

## Integrating

You integrate: rebase the worker's changes under your `@`, resolve, run the scoped checks for its change, then prune its workspace unless the next worker reuses it. Pushes wait for the landing turn: `land-check` stops until `fleet turn` says the fleet holds it (with no `fleet`, there is no turn to wait for).
