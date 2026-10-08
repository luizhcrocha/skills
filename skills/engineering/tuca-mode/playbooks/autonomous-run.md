# Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.**

1. State the exit condition as a checkable predicate before the first iteration: tests green, the repro fixed, all N changes landed, pixel diff zero.
2. Pick the wake mechanism. An event to watch (CI, a push, a file appearing, a process exiting) → a background Bash command that exits on the event (it re-invokes you), or a Watcher subagent ([MODELS.md](../../../productivity/coordinator/MODELS.md)), with a long heartbeat under `/loop` as the fallback. No event → `/loop` at an interval sized to when the result is worth re-checking.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, keeps it as a described jj change when it advanced, and abandons it (`jj abandon`, or `jj restore`) when it did not. A "might help" change is reverted, not left to ride. One unit verified before the next (Sequence Work into Verifiable Units).
4. Mid-run discoveries are yours: a broken skill, a related bug, a flaky check, tooling failures, fixable drift. Each goes in its own jj change. Reversible work is never parked for Luiz and never asked about. Surface only the pause list in [Autonomy](../SKILL.md#autonomy), a product or preference call no experiment can settle, or a real dead end. Return to the predicate after each side fix.
5. Keep the decision trail with `tstack:show-me-your-work`: one row per iteration (what changed, the predicate before and after, kept or abandoned), audited and reviewed before the reply.
6. Stop when the predicate holds. A plateau is not a stop: pivot the approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory. Code that should land runs the Land playbook.

**Reply:** the exit condition, iterations run, what landed, what was discarded, the final predicate state, the decision-trail path.
