# Refactoring

**You own the contract. The structure changes; the behaviour does not.** Feature adds behaviour and Bug fix corrects it; this playbook does neither.

A cleanup that reveals a missing feature or a real bug splits it out: the structural change lands first against the pinned contract. A redesign is allowed, but name it and route it to Feature. Large or cross-cutting structural work gets a bespoke plan (pending merge: figure-it-out) or the coordinator; this playbook is the focused-to-medium change.

1. Pin the behaviour contract first. Map the subsystem (`tstack:how`), then write a characterization test, snapshot or equivalence harness that captures current behaviour before any structure moves. No coverage → write the pin before touching structure. Type check and lint are not a pin.
2. Name the structure the code is missing (Model the Domain). Boring code stays when its shape is already clear and local. The reshape deletes branches or invalid states; it does not add indirection.
3. Name the target shape: the module layout, types and call graph as if built today (Foundational Thinking, Redesign from First Principles), in `tstack:codebase-design` vocabulary. A target that crosses a function boundary gets designed twice first (DESIGN-IT-TWICE.md; pending merge: architect).
4. Subtract before you add: delete dead code, collapse one-caller wrappers, drop redundant validators and orphan references before the new shape goes in (Subtract Before You Add). The smallest change that reaches the target lands (Laziness Protocol). A speculative cleanup that "might help" gets reverted.
5. Move in small behaviour-preserving steps, each keeping the pin green. An API reshape migrates every caller and deletes the old API in the same wave (Migrate Callers Then Delete Legacy APIs): no shims, no parallel paths. Check every rename against the files: strings, prose and back-references hide usages. Delegate mechanical edits to a Sonnet subagent, judgement-heavy moves to Opus, each in its own jj workspace with the names being moved and the behaviour to hold.
6. Prove behaviour is unchanged on the real artifact (Prove It Works). A larger reshape gets an equivalence check: a script diffing old and new outputs, a recorded baseline replayed, or a smoke run on the matching surface.
7. Confirm the change earns its keep: reader load went down somewhere (Minimize Reader Load). If it did not, revert.
8. Shape the history: a subtraction change, then the reshape, then any follow-on cleanup, each green (Sequence Work into Verifiable Units). Run the Land playbook.

**Reply:** the structure that changed, the pin it was held against, the equivalence proof, the reader-load delta, what landed and what was reverted. No new behaviour.
