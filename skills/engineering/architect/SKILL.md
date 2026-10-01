---
name: architect
description: "Sketch types, signatures and the module map from competing candidates before code, then implement against it. Use for \"architect this\", \"design this first\", \"sketch the types\", or non-trivial work."
---

# Architect

Design before implementing. Sketch the types, signatures, module map and seams with `not implemented` bodies and pseudocode, synthesized from competing candidates; then fill in code against the chosen sketch. If implementation proves the sketch wrong, throw it out and redesign. Adapted from poteto's pstack (MIT).

Speak `tstack:codebase-design`'s vocabulary throughout (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**), and the project's domain language from `CONTEXT.md` and its ADRs.

Open a todo list with the phases before starting: Ground, Sketch, Agree (`skip: no checkpoint asked` unless one was), Implement, and Scrap as a standing check.

## 1. Ground

Build a real mental model of every system the new code touches: run `tstack:how` over the relevant subsystems. Naming a file is not grounding; the traced model `how` returns is. When the design redefines ownership or layering, also run `tstack:why` on the existing shape, so its reasons become constraints rather than guesses.

Skip only for genuinely greenfield work with no surrounding system. Done when you can name the modules, seams and callers the design must fit, and the constraints it must honor.

## 2. Sketch

Run `tstack:arena` with the design-sketch task and the grounding from step 1:

- **Runners**: the design-task constraints from codebase-design's DESIGN-IT-TWICE.md, one per runner. Each runner's brief is [references/runner-prompt.md](references/runner-prompt.md) plus the inputs it names: its constraint, the grounding, its jj workspace, and absolute paths to this skill and to `tstack:principles`.
- **Artifact**: a design package per candidate, shaped by [references/rationale-template.md](references/rationale-template.md): the caller's usage first, then the type sketch derived from it.
- **Design it twice**: at least two structurally distinct candidates before synthesis, even when the first looks sufficient (Exhaust the Design Space). Whole-shape alternatives, not point fixes inside one shape.
- **Screen**: check every candidate against codebase-design's [RED-FLAGS.md](../codebase-design/RED-FLAGS.md) before synthesis; revise or reject shallow modules, information leakage, temporal decomposition and pass-through methods.
- **Prefer depth**: among viable candidates, prefer the one that hides more behind a smaller interface. A rich interface that concentrates capability keeps call chains short; scattering it across layers does not.

Arena returns one synthesized design package; its synthesis note fills the template's "Synthesis decision" section. The sketch may land as its own jj change before any implementation (scaffold first, Foundational Thinking); planned and scoped breakage while filling it in is fine (Outcome-Oriented Execution). For adversarial pressure on the sketch before implementing, run `tstack:interrogate` on it. Done when the sketch and its rationale are written and screened.

## 3. Agree (only when asked)

By default, go straight to implementation: no checkpoint. Only when the invoker asks ("architect with checkpoint", "show me before implementing") surface the synthesized design and wait for sign-off.

Pushback on the shape, at a checkpoint or later, is grounding evidence: re-ground (step 1) and re-run step 2 before writing more code.

## 4. Implement against the sketch

Replace `not implemented` bodies with code and pseudocode with logic; the sketch is the contract. Test-first at the sketch's seams with `tstack:tdd`.

A deviation from the sketch is signal to surface, not friction to absorb. When a function needs a parameter the sketch did not anticipate, decide whether the sketch was wrong, the requirement was missed, or the implementation is overreaching, and say which in the reply.

## 5. Scrap when the architecture is wrong

When implementation keeps producing friction the sketch cannot absorb, throw the sketch out rather than bolting fixes onto a wrong design (Redesign from First Principles, Fix Root Causes). The signal is a *pattern*, not a single instance. Tells:

- The same shape of workaround appears across unrelated code.
- Several unrelated edge cases each need a special-case branch.
- Types need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex, where the sketch said the state was not shared.
- Callers must know the module's internal rules to use it.
- Two or more independent step-4 deviations of the same shape.

A few edge cases do not condemn an architecture, and complexity in the data is not complexity in the design. When you scrap:

1. Re-run `tstack:how` over what has been built.
2. Redesign as if the new constraints had been day-one assumptions (Redesign from First Principles).
3. Subtract before adding (Subtract Before You Add): the new sketch is smaller than the old one before it grows.
4. Return to step 2 and re-run arena.

## Output

The caller's usage first and the type sketch derived from it: one file of new types and signatures for a small change, a module map plus type definitions for larger work. The rationale ships beside it, shaped by [references/rationale-template.md](references/rationale-template.md), with the usage sketch and the synthesis decision.
