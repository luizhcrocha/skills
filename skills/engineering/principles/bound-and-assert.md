---
name: principle-bound-and-assert
description: "Apply when writing or reviewing a function, a loop, a queue, a retry or a state transition. Put a limit on everything, assert what the code believes, and crash on a broken belief."
disable-model-invocation: true
---

# Bound and Assert

Safety first, then performance, then developer experience: TigerBeetle's TigerStyle, whose full text is [references/TIGER_STYLE.md](references/TIGER_STYLE.md). Two of its habits apply in every repo, in every language.

**Why:** a limit turns an infinite loop or a tail-latency spike into an error at a known place. An assertion turns silent corruption into a crash at the point of fault, which a property test, a fuzzer or a simulation then finds. Without assertions those tests only catch what reaches an output.

**Put a limit on everything.**
- Every loop, queue, buffer, retry, batch and recursion depth has a fixed upper bound, named as a constant (`retries_max`, `queue_depth_max`). A loop that must never end (an event loop) asserts that.
- Exceeding a limit is an operating error: return it or shed load; never grow past it.

**Assert what the code believes.**
- Two kinds of error. An **operating error** is expected (bad input, a full disk, a timeout): handle it, at the boundary (Boundary Discipline). A **programmer error** is a broken belief about your own code: assert it, and crash. The only correct way to handle corrupt code is to stop.
- Assert arguments, return values, preconditions, postconditions and invariants, especially at a state transition. TigerBeetle averages two assertions per function; take that as the density to aim for in core logic, not in glue.
- **Pair** each important property: assert it where the data is written and again where it is read.
- Assert the **positive space** you expect and the **negative space** you don't (`if (a) assert(b)`); bugs live where data crosses between them. Tests feed both: valid data, invalid data, and valid data turning invalid.
- One condition per assertion: `assert(a); assert(b);`, so a failure names its cause.
- Assert relationships between constants where the language checks them before run time (Zig `comptime`, Rust `const _: () = assert!(...)`, a TypeScript type-level check).
- Assertions stay on in production unless one is measured to cost too much.
- Handle every error a call can return.

**The tests:**
- "What stops this from running forever, or growing forever?" If nothing, add the limit.
- "What does this function assume that it never checks?" Assert it.
- "Is this a failure the world causes, or one my code causes?" Handle the first; assert the second.
