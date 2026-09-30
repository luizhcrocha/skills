---
name: tdd
description: Test-driven development and choosing the right evidence. Use when writing or changing tests, building features or fixing bugs test-first, "red-green-refactor", deciding what kind of test a change needs (example, integration, property, model-based, fuzz, mutation, simulation), or proving a change works.
---

# Test-Driven Development

Every change ends with evidence that it works. This skill decides which evidence, then runs the red → green loop that produces it. Consult every section on every cycle, not after.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching. Language specifics (runners, property-test libraries, fuzzers) live in the language skill for the file you touch.

## 1. Pick the rung

Testing is a ladder: static checks, example tests at seams, integration on real dependencies, characterization, property, model-based, fuzzing, mutation, deterministic simulation. Climb only as far as the remaining risk demands. [ladder.md](ladder.md) has each rung, when it applies, and what gates it.

- **Choose by residual risk.** An invariant (round trip, idempotence, normalization) → a property test. A state machine or store → model-based. Concurrency, retries, crashes → simulation, and only on top of a model-based rung.
- **Maturity gates the cost.** A prototype stops at static checks and a few examples. A long-lived core module is expected to reach property or model-based tests.
- **A test is not always the evidence.** When a test would need broad harness setup, production-only state, or brittle substitutes for a small change, use the closest executable check instead: a repro script, a command, browser automation, a log assertion. No new test beats a bad test.

## 2. Agree the seams

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals. You can't test everything, so seams put the effort on the critical paths and complex logic.

Name the seams under test before writing any. When the user is present and the right seam is unclear, ask: "What's the public interface, and which seams should we test?" Otherwise pick them in `codebase-design` vocabulary (module, interface, depth, seam, adapter), state them in one line, and proceed. When the shape of the interface is itself in question, call the Skill tool with "codebase-design".

## 3. The loop

- **Red before green.** Write the failing test first and run it: it must fail for the intended reason. Passing, or failing for an unrelated reason, means the test or the repro is wrong: fix that before touching production code. Then write only enough code to pass.
- **Vertical slices.** One seam, one test, one minimal implementation per cycle; each test a tracer bullet that responds to what the last cycle taught you. Never all tests first, then all code: bulk tests verify imagined behavior and go insensitive to real changes.
- **Refactoring is not part of the loop.** It belongs to review (`review`), against a green suite.
- **Never weaken a test to match wrong code.** Change an assertion only when the expected behavior genuinely changed, and say why.

## 4. What a good test is

A good test calls the code the way its users do and asserts what they observe against an independent, literal expected value. It reads like a specification ("user can checkout with valid cart") and survives refactors because it doesn't care about internal structure. [tests.md](tests.md) has examples.

The check before keeping any test: **would it still pass if every function it imports returned `undefined`?** Then it observes no behavior; rewrite the assertion or delete it ([the principle](../principles/test-behavior-not-implementation.md); [tests.md](tests.md) lists the five shapes that fail this check).

- **Implementation-coupled**: substitutes internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of the interface). The tell: it breaks on a refactor that kept behavior.
- **Tautological**: the expected value is recomputed the way the code computes it, so it can never disagree with the code. Expected values come from a known literal, a worked example, or the spec.

## 5. Substitutes go through seams

Replace behavior only through a real seam: a constructor-injected dependency, a service or layer, a local database, a fake or recording adapter, a runtime-provided binding. Never through module-patching or method-spy APIs, in any language. [substitutes.md](substitutes.md) has the patterns, and when a fake is not enough proof (SQL semantics, runtime behavior).

## 6. Determinism

- Clock, randomness, IDs and I/O that affect an outcome sit behind seams the test controls. This is also what makes a later simulation rung possible; code without such seams records that as design debt.
- A randomized test (property, fuzz, simulation) prints its seed on failure, and a failure counts as reproduced only when its seed replays it.
- A flaky test is made deterministic or removed, never retried into green.

## 7. Report the evidence

End with the evidence, not the outcome:

- The failing-before check and the failure it produced; the passing-after run; nearby checks run.
- The **evidence tier** reached and the one the risk needed: `static < example < integration < property/model-based < simulated` (or `executable check` when section 1's no-test path applied). A gap between the two is named as an unproven claim, never presented as proven.
