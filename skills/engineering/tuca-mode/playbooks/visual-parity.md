# Visual parity

**You own pixel-exact equivalence. The baseline is the spec, and you do not touch it.** Equivalence is verified by image diff, not by eye.

1. Establish the baseline before any migration: a visual regression harness that screenshots the current component across its states (and the target, when matching two implementations). Screenshots come from a scripted headless browser (Playwright) for the harness, and claude-in-chrome for exploring a state by hand. The project's `verify-<app>` skill launches the app when it exists (`tstack:create-verification-skill` otherwise). One harness run shoots every state and writes a summary (each path and its diff result); rerun it per round instead of taking screenshots one call at a time. No baseline, no parity claim: this is a blocking prerequisite.
2. Hold the anti-shortcut clauses: no harness edits, no baseline edits, no restructuring a component to make a diff pass. A baseline that looks wrong → stop and ask.
3. Migrate one component at a time. Parallelize across jj workspaces, one owner per component (Separate Before Serializing Shared State); shared primitives migrate first as a blocking phase.
4. Verify each component against its baseline by image diff. A nonzero diff is a fail: investigate the pixel delta. Each component loops (under `/loop` when long) until its diff is zero.
5. Run the Land playbook per component or per safe batch.

**Reply:** the components migrated, each one's diff result, the harness location, what is left.
