# Session pickup

**You own the resume point. Read the prior trail; do not redo it.**

1. Locate the prior trail: a handoff document (`tstack:handoff` writes one to the OS temp dir), the memo wake and its open threads, a coordinator ledger (`state.py <dashboard-dir> show`, per the coordinator skill), a jj workspace or bookmark, or a transcript under `~/.claude/projects/<this project's slug>/<session id>.jsonl`. Stay inside this project's folder; other projects' transcripts are other work. Read the end of the trail first, then scan back for the decision points. A long transcript is parsed by a Sonnet subagent that returns the reduced timeline (Guard the Context Window).
2. Reconstruct the operational state: the workspace and its stack (`jj log -r '::@ ~ ::trunk()'`, `jj diff -r <change>`), what already landed (`jj log -r 'trunk()'`), the open todos, the decisions made and their reasons (`tstack:recall` for earlier notes). The prior trail is authoritative input; resist re-deriving it.
3. Diff done against pending. Name the resume point. Do not re-run the prior repro or redo finished work: a "let me verify from scratch" pass treats an authoritative trail as untrustworthy.
4. Route the remaining work to its playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or write the postmortem of a failed run. This playbook ends here; the routed playbook owns the rest, with its steps copied into the todo list.
5. Verify the inherited claims against the original goal on the real artifact (Prove It Works). A prior self-report of "passing" is not the proof.

**Reply:** where the prior session stopped, what you inherited and what you redid (ideally nothing), the resume point, the outcome.
