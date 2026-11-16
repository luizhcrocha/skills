+++
id = "01M4H05R8GQREECY5BH8BK2MHH"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "3642a3e1-f620-40cd-9c28-c4002130b266/interactive"
at = "2026-10-09T18:52:56Z"
+++
Rebase a stack onto master@origin BEFORE its full gate, not after: 1.9.19 passed the gate on 1.9.17, then rebasing onto 1.9.18 conflicted dashboard.html in 12 commits. Rebuild it per commit (bun build.ts). Forget workspaces only after the push succeeds.
