# Bug fix

**You own this task. Plan, review, verify.** Delegate the digging and the fix to subagents; stay in the lead.

Be scientific. Every line that lands traces to runtime evidence. A belt-and-suspenders change that "might help" is a hypothesis, not a fix, and it does not land. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies lands, nothing more. The loop is `tstack:diagnosing-bugs`; its phases are the spine of steps 1 to 5.

1. Build the feedback loop and reproduce it yourself on the matching surface (diagnosing-bugs Phases 1 and 2): a failing test, a CLI run diffed against a snapshot, a curl, the browser through claude-in-chrome. Ask Luiz only with a stated reason the surface cannot be reached, after driving it as far as it goes. Done when one command, already run, goes red on this exact symptom.
2. Binary-search the cause (Phases 3 and 4). Seed 3 to 5 ranked, falsifiable hypotheses from a map of the affected subsystem and its history (`tstack:recall`, `jj log -- <path>`). Each pass, take the split that cuts the most remaining space, get runtime evidence, eliminate. Instrument with tagged logs when state is unclear; do not guess. A long or stubborn hunt runs under `/loop`. Done when one mechanism survives and runtime evidence confirms it.
3. Plan the fix. Crossing a function boundary → design it first with `tstack:codebase-design` (pending merge: architect). Delegate the implementation to an Opus subagent in its own jj workspace, with the files, the mechanism and the red command in the brief.
4. Verify on the same surface (Phase 5): the original repro now passes. "Inconclusive" or the wrong surface is not a pass; flag it. A unit test shows branch behaviour, not bug absence.
5. Stage the changes so the failing test lands before the fix (`tstack:tdd` when the bug has a cheap local test path; skip it when the test would be expensive or unclear, and say so). This is Sequence Work into Verifiable Units. Clean up per Phase 6: tagged logs gone, the surviving hypothesis in the fix's description.
6. Run the Land playbook.

**Reply:** what was broken, the root cause, the fix, how you verified it. Paste the failing-then-passing repro output verbatim.
