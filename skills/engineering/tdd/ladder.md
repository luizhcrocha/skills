# The testing ladder

Each rung costs more to build and keep than the one below it, and proves something the one below cannot. Pick the lowest rung that covers the remaining risk; add a higher rung when the risk calls for it, not by habit. Language tools for each rung are in the language skill.

| # | Rung | Proves | Use when |
|---|---|---|---|
| 0 | **Static**: types, strict compiler, linters, custom lint rules | whole classes of error never compile | always; the cheapest proof. A mistake made twice becomes a lint rule |
| 1 | **Example tests at seams** (the red → green loop) | the behavior named in the example | the default for new or changed behavior |
| 2 | **Integration on real dependencies** | the adapter and its dependency agree | adapters, SQL, a runtime's semantics (a fake proves the contract, not the database) |
| 3 | **Characterization / golden** | behavior did not change | before restructuring untested code; output formats. Pin current output first |
| 4 | **Property** | an invariant holds over generated inputs | parsers, codecs, round trips (`decode(encode(x)) == x`), idempotence, normalization |
| 5 | **Model-based / stateful** | the real thing matches a trivial model over random command sequences | state machines, stores, caches, ledgers, protocols |
| 6 | **Fuzzing** (coverage-guided) | no input crashes or corrupts | untrusted or binary input, parsers exposed to the world |
| 7 | **Mutation** | the suite would catch a real bug | an occasional audit of a critical module's suite, not every change |
| 8 | **Deterministic simulation with fault injection** | the system survives crashes, reorderings, partitions, clock skew | concurrency, distribution, crash recovery |

## Choosing

- **By residual risk.** Name what could still be wrong after the change, then pick the rung that would catch it. An invariant → 4. Transitions → 5. Timing or faults → 8.
- **Maturity gates the cost.** A prototype: 0-1. A feature in a living app: 1-2, plus 3 when restructuring. A long-lived core module (money, state, a protocol): 4-5 expected. Rung 8 only when rung 5 already exists and the remaining bugs are timing or fault bugs.
- **Arbitraries are built through production constructors and parsers,** never by bypassing invariants. Invalid inputs are generated on purpose and labeled invalid.
- **A model for rung 5 is dumb on purpose**: a map, a list, a counter. If the model needs the same cleverness as the code, the property is wrong.

## Borrowed from TigerBeetle

TigerBeetle runs its whole database in a deterministic simulator with injected crashes, disk faults and network partitions; "if it isn't tested under realistic failure conditions in a deterministic simulation, it isn't done." Most code doesn't need the simulator. These parts are cheap and apply everywhere:

- **Nondeterminism behind seams from day one.** Clock, randomness, I/O and scheduling come in through interfaces. That costs nothing now and is what makes rungs 5 and 8 possible later. Code that reads the clock or the network directly records it as design debt.
- **Seeds are part of the result.** Every randomized run prints its seed; a failure is reproduced only when its seed replays it; the seed goes in the bug report.
- **Assertions in production code.** Check preconditions and invariants where they hold (roughly two per function in TigerBeetle's style). Under a property test or a simulation, an assertion turns silent corruption into a crash at the point of fault.
- **Small, bounded, static.** Bounded loops and queues, no unbounded growth, limits stated as constants: a smaller state space is one a test can cover.

## Evidence tiers

When reporting, name the tier reached and the tier the risk needed:

`static < example < integration < property/model-based < simulated`

`executable check` sits beside `example` when a repro command stood in for a test. A gap between reached and needed is an unproven claim, stated as one.
