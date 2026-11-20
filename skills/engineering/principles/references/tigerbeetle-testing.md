# How TigerBeetle tests

Read from the tigerbeetle repo at a2a3c706 (main, 2026-11-10), the CFO from tag 0.16.39, and the blog at `https://tigerbeetle.com/blog/<slug>`. Paths are relative to the repo. [simulation.md](simulation.md) adapts this; [vopr.md](vopr.md) and [TIGER_STYLE.md](TIGER_STYLE.md) are the vendored originals.

## What makes simulation possible

- Every source of nondeterminism is an interface with a simulated twin, injected at compile time. The production replica code runs unchanged inside the simulator. Examples: IO (`src/stdx/io.zig`), `Time` as `TimeOS` or `TimeSim` (`src/stdx/time.zig`), storage (`src/testing/storage.zig`), and the network and message bus (`src/testing/cluster/`).
- One thread, callbacks, no blocking. Functions run to completion without suspending (`TIGER_STYLE.md`; blog `2022-11-23-a-friendly-abstraction-over-iouring-and-kqueue`).
- Static allocation: nothing is allocated after init (`src/static_allocator.zig`).
- Each replica has its own simulated clock: linear, periodic and step offsets (`time.zig:180`).
- An in-house PRNG (`src/stdx/prng.zig`), so a library update can never change what a seed means. Sub-simulators take hierarchical sub-seeds, `prng.int(u64)` each (`vopr.zig:420-470`).
- The simulator needs assertions on: Debug or ReleaseSafe only. Expensive O(N) checks run only in simulation and test builds (`constants.verify`). A `test_min` config with tiny journals makes rare paths, such as wraparound and checkpoints, happen within seconds.

## The VOPR (`src/vopr.zig`)

- **Seed:** one u64, or the commit hash in CI, plus the commit. It's printed at startup with every option, and again on failure with "you can reproduce this failure with seed=".
- **Swarm (`options_swarm`, :379-527):** the seed draws everything:
  - 1 to 6 replicas, standbys, clients and batch limits;
  - 0-30% packet loss and 0-50% replay, clogging;
  - a partition mode: none, uniform size, uniform partition or isolate one, symmetric or asymmetric;
  - 0-10% read, write and misdirect faults, latencies.
  - At unit level, `random_enum_weights` switches some operation kinds off entirely (blog `2025-04-23-swarm-testing-data-structures`).
- **Network** (`src/testing/packet_simulator.zig`): exponential delay, loss, replay, per-path capacity, clogging and partitions. It injects no corruption: checksums make corruption the same as loss.
- **Storage faults stay inside the fault model** (`ClusterFaultAtlas`, `storage.zig:1018`): read, write, misdirected and crash-torn faults hit only areas marked faulty for that replica, and at least one replica always keeps a good copy. A run never fails on something the system never claimed to survive.
- **Crash, restart, pause, reformat and upgrade** are per-tick probabilities, each with a minimum stable time between events. Crashes are 10 times likelier while writes are in flight. An upgrade is a crash and restart onto a newer release.
- **Workload** (`src/state_machine/workload.zig`): ids are a reversible permutation of an index, so the workload knows each result in fixed memory.
- **Checkers:**
  - `StateChecker`: every replica commits the same prepare checksum per op, along a parent-hash chain.
  - `StorageChecker`: storage is byte-identical across replicas at checkpoints.
  - grid, journal and manifest checkers.
  - Invariants inside each replica, not only at the API (blog `2026-08-20-protocol-aware-dst`). For example, a block missing on one replica must be missing on all of them.
  - There's no in-sim linearizability checker: one canonical order plus the workload's auditor cover it, and Jepsen checks from outside.
- **Liveness** (`vopr.zig:893-929`; blog `2023-07-06-simulation-testing-for-liveness`):
  1. After the safety phase, pick a core of at least a view-change quorum.
  2. Restart and heal the core, and turn off its storage faults.
  3. Make every non-core failure permanent, and stop all new faults.
  4. Require convergence within 10M ticks.

  Stalls the design can't recover from are excused (`cluster_recoverable`).
- **Ending a run:**
  - The tick budget resets on each reply, so it measures stalls, not total length.
  - Known gaps exit 0 through `unimplemented()`, so a loop stops only on real failures.
  - Exit codes are distinct: crash 127, liveness 128, correctness 129.

## Fuzzers and the CFO

- **Registry:** about 20 per-component fuzzers in one registry (`src/fuzz_tests.zig`), each `main(gpa, .{seed, events_max})`. `fuzz smoke` runs them all with seed 123 and warns about any over 10 s. RAM is capped with `setrlimit`.
- **Recipe** (blog `2025-11-28-tale-of-four-fuzzers`): find the component's minimal interface (plain integers, no framework types) and stub the rest. Then write:
  - a positive-space fuzzer, made exhaustive by a rigged PRNG (`src/testing/exhaustigen.zig`);
  - a negative-space fuzzer biased toward the valid/invalid boundary.

  Count the cases, and assert that both kinds occur. Run once with fixed seed 92 to check the distribution, and once with a random seed for coverage.
- **Blind spots** (blog `2025-06-06-fuzzer-blind-spots-meet-jepsen`): four structured fuzzers missed a query bug. The fix was unstructured random inputs plus a full reference model that checks exact output.
- **CFO** (continuous fuzzing orchestrator):
  - A fleet of machines loops `git fetch; reset --hard; run`.
  - Fuzzers are picked by weight: the VOPR 8, LSM 4, the rest 1-2.
  - A seed that runs past 30 minutes counts as a failure.
  - A canary fuzzer proves the pipeline is alive.
  - The budget is split 40:40:20 across main, PRs and release. A PR opts in with a `fuzz <name>` label.
  - Seeds go to a git repo of JSON (`devhubdb`), each with its commit and the exact repro command. Failing, faster-failing and older seeds are kept first.
  - Releases are tagged Friday and soak over the weekend.
  - The devhub publishes benchmarks and coverage of `vopr 92` and the fuzzers.

## Other tests

- **Snapshot tests:** `snap(@src(), \\text)` is a self-updating string literal. `SNAP_UPDATE=1` rewrites the source, and `<snap:ignore>` masks volatile text (blog `2024-05-14-snapshot-testing-for-the-masses`).
- **Scripted scenarios:** `TestContext` (`src/vsr/replica_test.zig`) builds a cluster on the same simulator with seed 123 and no random faults. A test scripts drops and partitions, and checks state. It's for paths random runs rarely reach, and for hand-reduced failures.
- **Marks:** production code logs `log.mark.info`, and a test asserts `mark.expect_hit()`, which ties that test to that line (`src/testing/marks.zig`).
- **Coverage by reflection:** model-based tests enumerate the public methods (`DeclEnum`), so a new method fails the test until a test covers it.
- **Assertions:**
  - two per function, paired at the call site and at the definition (blog `2023-12-27-it-takes-two-to-contract`);
  - `if (a) assert(b)` for an implication (blog `2025-05-26-asserting-implications`);
  - `maybe(cond)` to document that a condition is sometimes true;
  - assertions stay on in production.

## Debugging a seed

- Replay with `zig build vopr -- <seed>` on the same commit. `-Dvopr-log=short` prints one state-transition line per event: replica, event, role, status, view, commit, journal.
- Failed storage ops keep their stack traces, and a liveness failure dumps the cluster state.
- The seed is generated outside the test process, so a crash can't lose it.
- There's no automatic minimizer. The "finite PRNG" idea (blog `2023-03-28-random-fuzzy-thoughts`), where the seed encodes the entropy length, works for fuzzers, not for simulations. A failure gets reduced by hand into a `TestContext` test.
