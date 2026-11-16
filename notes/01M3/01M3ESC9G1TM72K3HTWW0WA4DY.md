+++
id = "01M3ESC9G1TM72K3HTWW0WA4DY"
kind = "open"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-26T12:00:00Z"
refs = ["claude-mem:sum:2777", "claude-mem:sum:2775"]
+++
code-review and implement still use git commands and resolving-merge-conflicts is git-only (stage/commit/rebase --continue); in jj repos the flow is `jj resolve` with no staging. None is jj-aware yet; tstack plan: make them jj-aware or fold into worktree-janitor.
