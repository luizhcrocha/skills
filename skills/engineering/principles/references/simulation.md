# Deterministic simulation

Rung 8 of the testing ladder (each lang-* skill's table): run the real code in one thread, with every source of nondeterminism replaced by a seeded fake that also injects faults, and check invariants after every step. TigerBeetle is the model: [references/tigerbeetle-testing.md](tigerbeetle-testing.md) has how it tests, with sources, and [references/vopr.md](vopr.md) its simulator's own doc. FoundationDB works similarly; Antithesis gets the same determinism from a hypervisor, with no ports in the code. Unmesh Joshi's [Deterministic Simulation Testing](https://martinfowler.com/articles/deterministic-simulation-testing.html) (martinfowler.com, 2026-11-17) builds one step by step in Java ([tickloom](https://github.com/unmeshjoshi/tickloom)).

It needs the ports from Own the Nondeterminism (`tstack:principles`) and an existing rung 5 model. Without the ports, adding them is the first lane of the work. In a service on an async runtime with SDKs that do their own I/O and timers, a whole-system simulator is rarely worth it: take the ports for clock, randomness, ids, fetch and the database, a rung 5 model, and recorded fuzz seeds, and leave whole-system determinism to a hypervisor.

## The harness

1. **One seed.** The run takes a seed (`u64`) from its arguments, or draws one outside the run's process and prints it first, with every option it picked, so a crash cannot lose it. One PRNG seeded from it makes every choice below; each sub-simulator (network, storage, clock, workload) takes its own sub-seed from it. The PRNG is your own code or pinned, so a library update never changes what a seed means. The seed and the commit are the whole reproduction.
2. **Swarm.** The seed first picks this run's parameters: how many nodes and clients, the batch sizes, the drop, delay, replay and partition rates (symmetric or not), the crash, restart and pause rates, the disk-fault rates, the clock-drift range, and which operation kinds the workload uses, some switched off entirely. A run with every fault turned up at once finds fewer bugs than many runs with different mixes.
3. **Simulated clock.** Time is a counter the harness advances by ticks; nothing sleeps. Every component is a `tick()` the loop calls in a fixed order, and each handler runs to completion without blocking: I/O returns a future that completes on a later tick. A timeout is a count of ticks, never a time-of-day reading. Each node has its own clock, with drift. A small test configuration (tiny logs and buffers) makes rare paths such as wraparound and checkpoints happen within seconds.
4. **Simulated network.** Messages go into a priority queue the harness owns, keyed by delivery tick and a sequence number so ties stay ordered; each tick it delivers, delays, drops, replays or clogs some, by the PRNG, and partitions nodes from each other. Where messages carry checksums, corruption is the same as loss and needs no injection. Simulating whole messages never runs the framing and codec code: those get their own rung 4 or 6.
5. **Simulated storage, inside the fault model.** Reads and writes go to memory, as two copies per file: visible bytes, and durable bytes that `sync()` copies them to. Read, write, misdirected and torn-write faults hit only what the system claims to survive (TigerBeetle: at least one replica always keeps a good copy), so every failure is a bug and never an impossible scenario.
6. **Crashes, restarts and upgrades.** Per-tick probabilities, each with a minimum stable time between events; crashes likelier while writes are in flight. A node restarts from its durable bytes, losing memory and every unsynced write. An upgrade is a crash and restart onto the newer release.
7. **Workload.** A seeded client sends operations from the rung 5 model's command set, valid and invalid. A workload that knows each expected result without a full model (ids as a reversible permutation of an index) runs in fixed memory. Unstructured random inputs checked against a full reference model catch what structured inputs miss.
8. **Checkers after every tick.**
   - The code's own assertions (Bound and Assert), including protocol invariants inside each component, not only at the API.
   - One canonical history: every node commits the same thing at each step, checked by checksum along a hash chain; replicas at the same point agree byte for byte; every acknowledged write survives a crash.
   - For a store clients read and write without one canonical order, record the client history (invoke and complete, Jepsen-style) and check it is linearizable (Knossos, Porcupine).
   - Expensive checks run only in simulation builds, and the simulator runs with assertions on.
9. **Liveness phase.** After the safety phase, pick a core big enough to make progress (a quorum), restart and heal it, turn off its faults, make every failure outside it permanent, and stop new faults. Require convergence within a tick budget. Stalls the design cannot recover from by its own claims are excused, and say why. Safety alone passes a system that stops making progress.

## Ending a run

- The tick budget resets on each completed request, so it measures stalls, not run length.
- Distinct exit codes: crash, liveness failure, correctness failure.
- A known gap in the system exits 0 through an explicit `unimplemented` marker, so a seed loop stops only on real failures.

## Running it

- **Replay and search are two uses of one seed.** Replay reruns a known seed to debug; many fresh seeds search for bugs, which only works because simulated time costs nothing.
- **In CI**: a fixed set of seeds on every change (TigerBeetle uses the commit hash as the seed), so a known failure stays fixed.
- **A fuzz farm** once the harness pays off:
  - machines loop fetch, reset, run;
  - fuzzers are picked by weight, the simulator heaviest;
  - a seed past its time limit counts as a failure;
  - a canary fuzzer proves the pipeline is alive;
  - each seed is recorded in a git-backed store with its commit and the exact repro command, failing seeds kept first;
  - a pull request opts in by label;
  - a release soaks before it ships.
- **A failing seed is the bug report:** the seed, the commit, the run's parameters, and a state-transition log (one line per event: node, event, role, status, view, commit) from a log flag. There is rarely an automatic minimizer for a simulation: reduce the failure by hand into a scripted test on the same harness, which steers the faults with no randomness, then fix it and add the seed to the CI set.
- A rare hard case (a split brain at one exact moment) gets a scripted test from the start.
- A fuzzer proves the presence of bugs, never their absence: write the assertions from a mental model of the code first, and treat the simulator as the last line of defence.

## Per language

The language skill's rung 8 row names the tools, and they cover different parts. `turmoil` (Rust) simulates hosts, network faults and time; `shuttle` and `loom` (Rust) and `fc.scheduler()` (TypeScript) cover interleavings; `testing/synctest` (Go) covers goroutines on a fake clock; Zig's `std.Io` and `std.Random` are the ports to write against. Storage faults, crashes and any part no library covers are the hand-written harness: a few hundred lines over the ports, a priority queue of events keyed by tick, and the PRNG.

## Done

The harness runs a seed range with no failure, the liveness phase converges on every seed, a failure seeded on purpose (a dropped assertion, a skipped fsync) is caught and replays from its seed, and the report names the fault model the run covered.
