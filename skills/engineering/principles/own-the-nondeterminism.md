---
name: principle-own-the-nondeterminism
description: "Apply when code reads the clock, draws randomness, does I/O, schedules work or reacts to outside events. Bring each in through a port, so one seed can replay any run."
disable-model-invocation: true
---

# Own the Nondeterminism

Time, randomness, the network, the disk, thread or task scheduling and generated IDs are the system's **nondeterminism**. Each comes into core logic through a port (`Clock`, `Rng`, `Network`, `Storage`), never by a direct call (`Date.now()`, `time.Now()`, `Math.random()`, `fetch`, `uuid()`).

**Why:** with every source behind a port, a test supplies a fake, and a simulation supplies one seeded implementation of all of them. Then any run, including a failing one, replays from its seed. This is how TigerBeetle's VOPR compresses days of faults into a minute ([tdd's simulation.md](../tdd/simulation.md)). The ports cost almost nothing on day one; adding them later means touching every caller.

**The pattern:**
- **Value before port.** What the core can be handed, hand it as an argument (`now`, a fresh id, a random draw). A port object is for what the core must ask for in the middle of a decision.
- Core logic takes the ports as arguments or constructor fields. Production passes the real adapters; tests pass fakes; a simulator passes seeded ones.
- **Run at your own pace.** Outside events go into a bounded queue; the core drains it in batches on its own tick, rather than doing work inside each callback. Control flow stays the program's, the work per tick stays bounded (Bound and Assert), and a simulator can drive the ticks.
- One seed drives every random choice in a run. A randomized test prints its seed; a failure is reproduced only when its seed replays it.
- Iteration order that affects output is fixed: sort, or use ordered maps.
- Core logic has no threads, executors or blocking calls: concurrency is the event loop's, and work that waits returns a future the loop completes. Enforce it with a check that fails the build: a lint rule (`tstack:correct`) or an architecture test, like the ArchUnit `DeterminismRulesTest` in Unmesh Joshi's DST article (linked from tdd's simulation.md), banning the clock, randomness, threads and unordered maps in core packages.

**The tests:**
- "Can a test set this code's current time?" If not, the clock is ambient.
- "Run it twice with the same seed and inputs: is the trace identical?" If not, find the leak (an ambient call, map order, a thread race).
- A direct call to the clock, randomness or I/O inside core logic is design debt. Record it where the code lives, or remove it.
