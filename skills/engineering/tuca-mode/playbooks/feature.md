# Feature

**You own the design. Plan, review, verify.** Delegate the implementation; stay in the lead.

1. Map the affected subsystem: `CONTEXT.md`, the ADRs, the modules and seams the feature touches. A Sonnet Explore agent does the reading when it spans more than a few files (pending merge: how).
2. Design the shape: name the data shape and its organizing structure (Model the Domain), the module and its interface, the seam it sits behind, in `tstack:codebase-design` vocabulary. A contested shape → design it twice (codebase-design's DESIGN-IT-TWICE.md), or two Opus agents in separate jj workspaces build competing shapes and you pick or graft (pending merge: architect, arena).
3. Write the throughput checkpoint as four todo items. A dimension that does not apply keeps its item with `n/a: <reason>`:
   - **Blocking first steps.** Gates that run before any fan-out (shared types, schemas, config).
   - **Independent workstreams.** Disjoint files, services or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Split the target first (Separate Before Serializing Shared State); serialize only for a real invariant.
   - **Smallest safe decomposition.** If one worker is best, say why.
4. Delegate the code to an Opus subagent in its own jj workspace with a specific scope: file paths, the named data shape and its structure (a state machine over scattered booleans, a table over branching, a typed model over repeated shape assumptions), the seam, and a checkable done criterion. Test-first at the agreed seams with `tstack:tdd`. Surgical edits; comments per [Comments](../SKILL.md#comments); a shared-primitive change reaches every consumer, each verified.
5. Verify on the matching surface: run it, drive it (claude-in-chrome for a UI), read the real output. "Inconclusive" or the wrong surface is not a pass; flag it.
6. Review: `tstack:code-review` against the spec, then `/simplify` (Claude Code built-in) over the diff. A contested design gets a fresh Opus reviewer told to break it (pending merge: interrogate).
7. Shape the history into small ordered changes, each landable and verified before the next (Sequence Work into Verifiable Units).
8. Run the Land playbook.

Code-coupled work (one feature) goes to a single owner with the checkpoint inline; that owner fans out after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts. Rewrite the checkpoint at phase boundaries, and spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. A table for design alternatives.
