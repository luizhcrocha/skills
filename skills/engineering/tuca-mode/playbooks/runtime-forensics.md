# Runtime forensics

**You own the diagnosis. Instrument the live process; do not theorize from source.** The deliverable is a cited diagnosis, not a fix.

1. Capture the live signal on the matching surface: a CPU profile for a spinning process (`perf`, `py-spy`, `node --cpu-prof`, the browser's profiler through claude-in-chrome), a heap snapshot for a leak, a trace for a visual glitch. A real artifact, not a guess.
2. Reduce the artifact to the smoking gun: the function on the hot path, the retainer chain from the leaked object to a root, the loop firing without input. A large artifact is parsed by a Sonnet subagent that returns the reduced finding (Guard the Context Window).
3. Prove the mechanism before believing it: inject instrumentation into the running process (a debugger, an eval in the page through claude-in-chrome, a tagged log hot-patched in) to confirm the hypothesis cheaply.
4. Map the finding back to source: file, symbol, the line that allocates or schedules.
5. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only forensics`.

**Reply:** the signal captured, the reduced finding, how the mechanism was proved, the source location, artifact paths. No fix unless asked; once the cause is known, hand back to Bug fix or Perf issue.
