---
name: principles
description: Engineering principles, one file each. Use when a design, refactor, debugging, testing or delegation decision needs a rule to settle it, or a playbook names a principle.
---

# Principles

One line per principle: when it applies, then its file. Read the file in full before you apply a principle, and name the principles that shaped a decision in your reply. Cite only principles whose file you read this session.

Adapted from poteto's pstack, MIT (synced through `upstreams.toml`; local edits merge on each sync).

## Core

- **Laziness Protocol** ([laziness-protocol.md](laziness-protocol.md)). Refactoring, sizing a diff, or tempted to add an abstraction, a layer or signal threading: bias to deletion and the smallest change that solves it.
- **Foundational Thinking** ([foundational-thinking.md](foundational-thinking.md)). Before writing logic: core types and data structures, scaffold before feature, what concurrent actors share.
- **Redesign from First Principles** ([redesign-from-first-principles.md](redesign-from-first-principles.md)). A new requirement meets an existing design: redesign as if it had been there from day one.
- **Attack the Premise** ([attack-the-premise.md](attack-the-premise.md)). Two fixes sharing one premise failed the same gate: census the actors, then question the premise.
- **Subtract Before You Add** ([subtract-before-you-add.md](subtract-before-you-add.md)). Sequencing an addition, refactor or rewrite: remove dead weight first.
- **Minimize Reader Load** ([minimize-reader-load.md](minimize-reader-load.md)). Code that is hard to trace: count layers and hidden state, collapse one-caller wrappers.
- **Outcome-Oriented Execution** ([outcome-oriented-execution.md](outcome-oriented-execution.md)). Planned rewrites and migrations: converge on the target, no throwaway compatibility states.
- **Experience First** ([experience-first.md](experience-first.md)). Product, UX or scope trade-offs: the user's experience over implementation convenience.
- **Exhaust the Design Space** ([exhaust-the-design-space.md](exhaust-the-design-space.md)). A novel interaction or architecture with no precedent: two or three competing prototypes before committing.
- **Build the Lever** ([build-the-lever.md](build-the-lever.md)). Any non-trivial work: build the tool that does or proves it (codemod, script, generator).

## Architecture

- **Model the Domain** ([model-the-domain.md](model-the-domain.md)). Stateful logic, heavy branching, a shape assumption repeated across files: encode it in a structure.
- **Boundary Discipline** ([boundary-discipline.md](boundary-discipline.md)). Validation, error handling, framework adapters: guards at the boundary, pure logic inside.
- **Type System Discipline** ([type-system-discipline.md](type-system-discipline.md)). Designing types or a signature: illegal states unrepresentable, parse at the boundary.
- **Make Operations Idempotent** ([make-operations-idempotent.md](make-operations-idempotent.md)). Commands, lifecycle steps or loops that crash and retry: converge to the same end state.
- **Migrate Callers Then Delete Legacy APIs** ([migrate-callers-then-delete-legacy-apis.md](migrate-callers-then-delete-legacy-apis.md)). A new internal API while old callers exist: migrate and delete in one wave.
- **Separate Before Serializing Shared State** ([separate-before-serializing-shared-state.md](separate-before-serializing-shared-state.md)). Concurrent actors may write the same file, bookmark, key or object: remove the sharing first.

## Verification

- **Prove It Works** ([prove-it-works.md](prove-it-works.md)). Before declaring done: check the real artifact, not a proxy or "it compiles".
- **Fix Root Causes** ([fix-root-causes.md](fix-root-causes.md)). Debugging: reproduce first, ask why until the root cause.
- **Sequence Work into Verifiable Units** ([sequence-verifiable-units.md](sequence-verifiable-units.md)). Multi-step work and how commits stack: small units, each ending in a check.
- **Test Behavior, Not Implementation** ([test-behavior-not-implementation.md](test-behavior-not-implementation.md)). Writing, changing or keeping a test: call it as users do, assert a literal expected value.

## Delegation

- **Guard the Context Window** ([guard-the-context-window.md](guard-the-context-window.md)). Large outputs, long files, repeated reads, fan-out planning: bulk to subagents, summaries in the main thread.
- **Never Block on the Human** ([never-block-on-the-human.md](never-block-on-the-human.md)). Tempted to ask "should I?" on reversible work: proceed, show the result, let Luiz correct.

## Meta

- **Encode Lessons in Structure** ([encode-lessons-in-structure.md](encode-lessons-in-structure.md)). Writing the same instruction a second time: make it a lint, a check or a script.
