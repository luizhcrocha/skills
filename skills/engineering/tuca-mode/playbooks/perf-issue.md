# Perf issue

**You own the measurement story. Plan, review, verify the numbers.** Every fix ties to a measurement; reading source is not measuring. `tstack:diagnosing-bugs` has the perf branch of the loop (baseline first, then bisect).

1. Capture a baseline on the matching surface: a timing harness, a profile, a query plan, a trace. Median of several runs, with the command that produced it.
2. Map the hot path to ground hypotheses (`tstack:how`). Claim no ceiling without running it. Most fixes come from eight strategy families; use them as hypothesis generators, and a family earns an attempt only when the trace shows its signal:
   - **Elimination.** Does the hot path need to exist at all: a computation nobody consumes, a gate always off, a redundant sync, a legacy path kept just in case? The profiler shows what is slow, never that it is deletable, so this family needs the map.
   - **Divide and conquer.** The cost scales with input size: split so each piece touches less, or run independent pieces in parallel.
   - **Caching.** The same computation or fetch repeats on identical inputs. Name what invalidates it before claiming the win.
   - **Indirection.** A cheaper intermediate could absorb the work: an index instead of a scan, a queue off the interactive path. Add the hop only when it removes more than it adds.
   - **Batching.** Many small operations each pay a fixed overhead (RPC, query, syscall): coalesce them.
   - **Redundancy.** The wait hangs on one slow instance: hedge or replicate, only when the trace shows the wait dominates and there is headroom.
   - **Lazy evaluation.** Cost lands on results never used or not needed yet: defer to first use.
   - **Scheduling.** The work must happen, but not while someone waits: move it to idle time, a warmup, a precompute. Measure the interactive path.
3. Plan the fix from the trace. Crossing a function boundary → design it first with `tstack:codebase-design`. Delegate the change to an Opus subagent in its own jj workspace; review the diff; capture a post-fix measurement with the same harness. One attempt verified before the next (Sequence Work into Verifiable Units).
4. Compare the artifacts, not impressions: parse both (JSON to sqlite, a diff) and state the delta. "Inconclusive" or the wrong surface is not a pass; flag it.
5. Put the measurement (before → after, with its unit and command) in the change description.
6. Run the Land playbook.

For sustained improvement against a metric rather than a one-off fix, use Hillclimb.

**Reply:** baseline, post-fix number, delta, the harness command and artifact paths.
