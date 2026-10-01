# Session pickup

**You own the resume point. Read the prior trail; do not redo it.**

1. Locate the prior trail: a handoff document (`tstack:handoff` writes one to the OS temp dir), the memo wake and its open threads, a decision log the prior run kept (`tstack:show-me-your-work`), a coordinator ledger (`fleet state <dashboard-dir> show`, per the coordinator skill), a jj workspace or bookmark, or a transcript under `~/.claude/projects/<this project's slug>/<session id>.jsonl`. Stay inside this project's folders; other projects' transcripts are other work. Not sure which session it was → `tstack:recall`'s catch-up lists this project's recent sessions and mines them; its `sessions.py digest` reduces one transcript to a timeline. Read the end of the trail first, then scan back for the decision points. A long transcript is parsed by a Sonnet subagent that returns the reduced timeline (Guard the Context Window).
2. A fleet ledger in the trail (a manager's or a coordinator's dir under the scratchpad): this session is that fleet's again. Run its skill's resume step first (`fleet serve <dir>`, the chat watch), since the page and the watch died with the old process.
3. Reconstruct the operational state: the workspace and its stack (`jj log -r '::@ ~ ::trunk()'`, `jj diff -r <change>`), what already landed (`jj log -r 'trunk()'`), the open todos, the decisions made and their reasons (`tstack:recall` for earlier notes). The prior trail is authoritative input; resist re-deriving it.
4. Diff done against pending. Name the resume point. Do not re-run the prior repro or redo finished work: a "let me verify from scratch" pass treats an authoritative trail as untrustworthy. Continuing a decision log, this run's first row is a `start` row (`tstack:show-me-your-work`).
5. Route the remaining work to its playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or write the postmortem of a failed run. This playbook ends here; the routed playbook owns the rest, with its steps copied into the todo list.
6. Verify the inherited claims against the original goal on the real artifact (Prove It Works). A prior self-report of "passing" is not the proof.

**Reply:** where the prior session stopped, what you inherited and what you redid (ideally nothing), the resume point, the outcome.
