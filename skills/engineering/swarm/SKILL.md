---
name: swarm
description: "Fan out N parallel workers over slices or race arms and return one PASS / ISSUES / BLOCKED report. Use for \"swarm this\", coverage matrices, races, best-of runs, gauntlets of checks."
---

# Swarm

Fan out N parallel workers. They cover separate slices, race the same brief, or both. You wait, aggregate, and return one report. Adapted from poteto's pstack (MIT).

Which fan-out:

- **swarm**: N workers, one verdict table. Coverage, races, gauntlets, exploration; the workers mostly check, measure or explore.
- **`tstack:orchestrate`**: a batch of different tasks that change code, partitioned by file ownership and integrated into one codebase.
- **`tstack:arena`**: N attempts at one design or artifact under distinct constraints; a base is picked and the others grafted in by hand.
- **the coordinator** (`/tstack:coordinator`, user-invoked): a standing program whose lanes outlive the session's attention, with a ledger and a dashboard.

Open a todo list with the four phases before launching anything: Frame, Fan out, Aggregate, Report.

## 1. Frame

1. State the done predicate and the report or artifact the swarm returns.
2. Choose the shape. Partition into slices (a coverage matrix, a gauntlet of checks, an exploration partition), race N workers on identical briefs, or mix both. For a race or a mix, declare the selection rule before spawning:
   - `first pass`: the first arm to report `PASS` wins; stop the rest (TaskStop).
   - `rank all`: every arm reports; rank them by a metric named now.
   - `best-of`: N runs of one brief, the best by a metric named now (also a flakiness probe: the spread is a finding).
3. Set N from the user, or derive it from the shape. N is the total number of workers.
4. Pick each worker's model by its job. Coverage, exploration, checks, measurement and other legwork: `model: "sonnet"`. A race whose arms write code, or a worker whose job is judgement (debugging, design): `model: "opus"`. A race of models names each arm's model up front; a model other than these is a proposal Luiz approves first.
5. Give each worker its own place to write. A worker that writes code gets its own jj workspace from the same base: `jj workspace add ../<repo>-swarm-<n> -r <base> --name swarm-<n>`. Other outputs go to `<scratchpad>/swarm-<slug>/<n>/`. When workers verify or measure commits, each brief names the exact change ids and commit ids; a measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

Done when the predicate, the shape, the rule (for a race), N, each worker's model and each output place are written down.

## 2. Fan out

Spawn all N workers in one message: the Agent tool, `subagent_type: "general-purpose"`, `run_in_background: true`, the model from step 4. Every worker runs on this machine; there are no cloud workers. A swarm in the dozens or more runs as a Workflow only when Luiz opted into a workflow for this run (the `workflow-authoring` skill has the script API).

Every brief stands alone: the goal, the scope, the exact slice or race arm, its output place, how to verify, and what to report. Reports use `PASS`, `ISSUES` or `BLOCKED`, with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

A worker that drops out: proceed with N-1 and note it. Done when every worker has returned or dropped out.

## 3. Aggregate

Read each result as its notification arrives. Drop a result that does not record the ids and method its brief names, and rerun that worker once; after a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the rule declared in step 1.

Code from a race arm is a claim until you read it: read the winner's diff, then bring it into the caller's stack (`jj rebase` or `jj squash` from its workspace). Then every `swarm-<n>` workspace goes: `jj workspace forget swarm-<n>`, remove its directory, and abandon the changes not kept.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts; raw worker dumps stay out. Done when every slice or arm has a verdict or a named gap, and no swarm workspace is left.

## 4. Report

One consolidated reply: the table (slice or arm, model, verdict, evidence), the issue one-liners, gaps and dropouts, and for a race the rule and the winner.
