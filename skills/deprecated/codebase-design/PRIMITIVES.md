# Primitives

For a design that exposes several operations to callers: a library surface, a CLI, a tool set, an API. Cut the primitives before the signatures. A module with one operation or one caller skips this file.

1. **Earn it.** A primitive serves two real call sites from the usage sketch. With one, it is a hypothesis: keep it private.
2. **Meaning.** One line per primitive: "X means (a simple model)": a map, a set, a log, a function from time to a value. No word about the implementation. Give each operation its meaning on that model. An operation that needs a special case to fit shows a wrong cut: change the model or split the primitive. When no simple model exists, the thing is data: keep it a plain record.
3. **Laws.** Two or three equations between the operations, written as property-test names: identity, idempotence, round trip (`undo(do(x)) = x`), associativity, commutation, and closure (one operation's output is another's input, with no glue). Operations with no law between them are a bag of functions. A law you want and cannot have marks a miscut.
4. **Mechanism, not policy.** For each branch, default and enum inside a primitive: would two plausible callers want opposite behaviour? Then it is policy: lift it to a parameter or to the layer above. Does every caller pass the same value? Then it is a constant: delete the parameter.
5. **Plumbing, then porcelain.** Plumbing is the primitives: one job each, values in and out, stable. Porcelain is the workflow-shaped calls a caller reaches for first, each written only from plumbing. Porcelain that cannot be written that way shows a missing primitive. Add porcelain where the sequence never varies; leave plumbing where the decision is the caller's. An agent caller pays for every operation it must choose between.
