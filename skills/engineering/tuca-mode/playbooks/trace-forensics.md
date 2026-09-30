# Trace forensics

**You own the diagnosis from the artifact. Load it, shape it, narrow to the cause, attribute it to source.** Runtime forensics instruments the live process; here the capture already exists. The artifact is a fixed dataset: read it, do not re-run it.

1. Identify the format (cpuprofile, `.json.gz` trace, perf data, spindump, heap snapshot) and load it with the right tool. A large artifact is parsed by a Sonnet subagent; the main thread keeps the reduced finding (Guard the Context Window).
2. Transform it into a queryable form before reading: dump it into sqlite, one row per sample, frame or node.
3. Narrow to the cause. Query for the frames that hold the most time and walk the call tree to the hot path. For a leak, follow the retainer chain to a root. For a hang, find the thread stuck on-CPU or blocked, and its wait reason.
4. Attribute to source: map the hot frame to file, symbol and line through the artifact's own symbols. A frame with no source mapping is not yet a diagnosis: resolve the symbols, or say plainly the artifact lacks them.
5. Confirm against a paired capture when there is one: diff before and after. Without one, the finding is the strongest hypothesis the artifact supports, labeled as such.
6. Hand back a cited diagnosis; no fix unless asked. Route to Bug fix or Perf issue once the cause is known. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only forensics`.

**Reply:** the artifact and its format, the reduced finding, the source location, the artifact paths, and whether a paired capture confirmed it.
