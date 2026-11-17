# Deterministic simulation

Rung 8 of [the ladder](ladder.md): run the real code in one thread, with every source of nondeterminism replaced by a seeded fake that also injects faults, and check invariants after every step. TigerBeetle's VOPR is the model ([references/vopr.md](references/vopr.md)); FoundationDB works similarly; Antithesis gets the same determinism from a hypervisor, with no ports in the code. It needs the ports from Own the Nondeterminism (`tstack:principles`) and an existing rung 5 model. Without the ports, adding them is the first lane of the work.

## The harness

1. **One seed.** The run takes a seed (`u64`) from its arguments, or draws one and prints it first. One PRNG seeded from it makes every choice below. The seed and the commit are the whole reproduction.
2. **Swarm the fault rates.** The seed first picks this run's parameters: how many nodes, the drop, delay, reorder, duplicate and partition rates, the crash and restart rates, the disk-fault rate, the clock-drift range. A run with every fault turned up at once finds fewer bugs than many runs with different mixes (swarm testing).
3. **Simulated clock.** Time is a counter the harness advances by ticks; nothing sleeps. A run covers hours of timeouts in seconds.
4. **Simulated network.** Messages go into a queue the harness owns; each tick it delivers, delays, drops, reorders or duplicates some, by the PRNG, and partitions nodes from each other.
5. **Simulated storage.** Reads and writes go to memory. Faults stay inside the fault model the system claims to survive: a torn or lost write, a corrupted read on one node, never on every copy at once.
6. **Crashes.** A node stops between any two steps and restarts from what its storage holds, losing memory and anything not yet fsynced.
7. **Workload.** A seeded client sends operations from the rung 5 model's command set, valid and invalid.
8. **Checkers after every tick.** The code's own assertions (Bound and Assert) plus checkers outside it: the system's state matches the rung 5 model; replicas that agree on a point agree byte for byte; every acknowledged write is still there after a crash.
9. **Liveness phase.** After the faults, heal everything: reconnect the network, restart nodes, stop injecting. Assert the system converges and serves requests within a bounded number of ticks. Safety alone passes a system that stops making progress.

## Running it

- **In CI**: a fixed set of seeds on every change, so a known failure stays fixed. **Locally or overnight**: fresh random seeds for as long as the budget allows, many runs in parallel.
- A failing seed is the bug report: the seed, the commit, the run's parameters, and the last ticks of a trace. Replay it, minimize it, fix it, then add the seed to the CI set.
- A rare hard case (a split brain at one exact moment) gets a scripted test on the same harness, which steers the faults by hand.
- A fuzzer proves the presence of bugs, never their absence: write the assertions from a mental model of the code first, and treat the simulator as the last line of defence.

## Per language

The language skill's rung 8 row names the tools, and they cover different parts. `turmoil` (Rust) simulates hosts, network faults and time; `shuttle` and `loom` (Rust) and `fc.scheduler()` (TypeScript) cover interleavings; `testing/synctest` (Go) covers goroutines on a fake clock; Zig's `std.Io` and `std.Random` are the ports to write against. Storage faults, crashes and any part no library covers are the hand-written harness: a few hundred lines over the ports, a priority queue of events keyed by tick, and the PRNG.

## Done

The harness runs a seed range with no failure, the liveness phase converges on every seed, a failure seeded on purpose (a dropped assertion, a skipped fsync) is caught and replays from its seed, and the report names the fault model the run covered.
