# Hillclimb

**You own the metric and the experiment's integrity. Supervise and review; delegate the attempts.** Sustained, iterative improvement of one measurable thing against a target. A one-off fix is Bug fix or Perf issue; this is the loop.

Core discipline: one change, one measurement, keep or revert. Never stack untested changes; never claim a win from reading code (Prove It Works).

1. Ground the workload before choosing the metric. Map the target (`tstack:how`), name the workload dimensions that move the result (data size, history, state, concurrency), and pick a case that reproduces Luiz's complaint. No case reproduces it → fix the repro first. Then fix one metric, the direction that counts as better, and a checkable stop predicate that pairs a target with a floor on attempts ("at least 50% better than baseline and at least 10 iterations"). Use Luiz's numbers when given.
2. Build the measurement harness, prove its sensitivity, then freeze it (Build the Lever). Contrasting workloads separate as expected; one command emits the metric as a median of N runs. Record the baseline and a green run of the regression gate (the tests that must keep passing) before any change.
3. Open the decision log with `tstack:show-me-your-work`, one row per attempt: the hypothesis and change as the decision, before → after with the delta and the gate as the result, kept or abandoned. Read it before each attempt.
4. Ground each hypothesis in the step-1 map, so it names a mechanism ("defer X off the boot path because it blocks first paint"), not "try memoizing something".
5. Loop, one hypothesis per iteration:
   - Hand the change to an Opus subagent with a tight scope, in its own jj workspace; review the diff rather than typing it (Guard the Context Window). Several independent hypotheses → parallel subagents, one workspace each (Separate Before Serializing Shared State).
   - Measure before and after with the frozen harness; run the gate.
   - Keep only when the metric moves past noise and the gate stays green; otherwise `jj abandon` the change. A tweak that "might help" is not kept.
   - One described jj change per accepted win. Log the row either way.
   A run Luiz leaves unattended borrows the wake mechanism of Autonomous run, not its stop rule.
6. Push past the first plateau: on several rejects in a row, pivot category, combine near-misses, re-read the source, try something more radical. Correctness and simplicity outrank the number: revert a win that breaks behaviour, keep a simplification that holds the number (Laziness Protocol).
7. Stop when the predicate holds, or when the remaining ideas are marginal. Never relax the predicate; do not quit while cheap untried hypotheses remain. Stuck → surface it.
8. Run the Land playbook with the accepted changes stacked in the order they were won.

**Reply:** the metric and target, baseline to final with the percent delta, iterations (kept and reverted), each accepted win on one line, the decision-log path, and the next idea you would try.
