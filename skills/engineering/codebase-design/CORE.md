# Core

The shape of the logic behind the interface, for a module that holds state or causes effects. Take the highest rung that fits, and say in the rationale which rung each core module sits on and why not the one above.

1. **Values in, decision out.** `decide(state, input) -> (state, effects)`, or `decide -> events` with a separate `evolve(state, event) -> state`. Everything nondeterministic is an input: `now`, a fresh id, a random draw arrive as arguments. What the core wants done leaves as a closed set of effect values (`Send`, `Persist`, `SetTimer`) that the shell performs. A core that waits returns its next deadline, and the shell wakes it. Rules live in `decide`; `evolve` only applies.
2. **Split at the read.** A decision that needs data which exists only after an effect becomes two decisions with state between them.
3. **Port.** When the steps interleave too finely for rung 2 (a query per item, a stream), the core takes a port, per Own the Nondeterminism (`tstack:principles`) and the dependency categories in [DEEPENING.md](DEEPENING.md). Accept the dependency; never construct it inside.

**The tests:**
- A core function takes a parameter that performs I/O: pass its result instead.
- A test builds every input from a literal and asserts on the returned value. Logic that needs a mock to be tested is on the wrong side of the seam.
- One function owns each branch. A helper that takes an optional or a flag and returns early: take the value, and let the caller branch. The same condition in two functions: hoist it.
- Operations take a batch: the loop inside, the branch outside.

**The cost:** rung 1 needs an effect type and a loop that performs it. A module with no state and one effect stays a function the shell calls.
