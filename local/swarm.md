---
description: "Fan out N parallel workers over slices or race arms into one report. Use for \"swarm this\", coverage matrices, best-of runs, or check gauntlets."
---

- Workers are background Agent calls on this machine, each in the role its job needs ([models.md](../docs/models.md)): Readers for coverage, checks and measurement, Researchers for exploration, Implementers for arms that write code or judge. Fan-out never runs on Fable.
- A worker that writes code gets its own jj workspace (`ws-add swarm-<n> -r <base>`). Bring the winner in with `jj squash` or `jj rebase`, then forget each workspace, remove its directory, abandon the rest. `tstack:jj` has the rules for working beside other workspaces.
- A brief that verifies or measures commits names the change and commit ids and the method; drop a result that does not record them.
- Different code-changing tasks fan out here too, partitioned so no two workers own one file. Competing designs go to `tstack:arena`. A swarm of dozens runs as a Workflow only when Luiz opted in.
