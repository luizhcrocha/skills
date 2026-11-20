# Smell baseline

The Standards axis of [review](SKILL.md) always carries this baseline, even when the repo documents nothing: a fixed set of Fowler's code smells (_Refactoring_, ch.3) plus four of ours. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something a smell would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation, and always a Nit. Skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.
- **Implicit State Machine** (ours, not Fowler's; `tstack:principles`, Model the Domain): a lifecycle spread over booleans, nullable modes, flags or a status string checked in several places, so invalid combinations are representable (`isLoading && error`), or a one-off flag threaded into an unrelated flow. → one explicit state type (an enum or discriminated union) with its transitions in one place; a policy object or module for a flag that belongs elsewhere.
- **Unbounded** (ours, TigerStyle; `tstack:principles`, Bound and Assert): a loop, queue, buffer, retry or recursion added with no upper bound, or a bound written as a bare number. → a named limit constant, and an operating error when it is reached.
- **Ambient Nondeterminism** (ours; `tstack:principles`, Own the Nondeterminism): core logic that calls the clock, randomness, an ID generator or I/O directly, or whose output depends on map iteration order. → take it through a port, or sort.
- **Unasserted Transition** (ours, TigerStyle; `tstack:principles`, Bound and Assert): a state change, or a function on a money, state or protocol path, that checks none of what it assumes; or a programmer error handled as if it were bad input. → assert the precondition and the invariant after the change; crash on a broken belief.
