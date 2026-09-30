# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, run this as an arena. Based on "Design It Twice" (Ousterhout): your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md): **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before the arena runs, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints, not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the runners work in parallel.

### 2. Run the arena

Run `tstack:arena` with this as its frame; its phases do the fan-out, the blind cross-judge, the pick and the graft. Give it:

- **The artifact.** A candidate interface for the deepened module, with a technical brief independent of the Step 1 explanation: file paths, coupling details, the dependency category from [DEEPENING.md](DEEPENING.md), what sits behind the seam. Each candidate outputs:
  1. Interface (types, methods, params, plus invariants, ordering, error modes)
  2. Usage example showing how callers use it
  3. What the implementation hides behind the seam
  4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
  5. Trade-offs: where leverage is high, where it's thin
- **One constraint per runner**, each producing a **radically different** interface:
  - Runner 1: "Minimize the interface: aim for 1–3 entry points max. Maximise leverage per entry point."
  - Runner 2: "Maximise flexibility: support many use cases and extension."
  - Runner 3: "Optimise for the most common caller: make the default case trivial."
  - Runner 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."
- **The vocabulary.** Both [SKILL.md](SKILL.md) vocabulary and CONTEXT.md vocabulary in the brief, so each runner names things consistently with the architecture language and the project's domain language.
- **The rubric.** Depth (leverage at the interface), locality (where change concentrates), seam placement, and whatever this candidate's constraints add. Screen each candidate against [RED-FLAGS.md](RED-FLAGS.md) before picking.

### 3. Present and compare

Present the designs sequentially so the user can absorb each one, then compare them in prose by **depth**, **locality**, and **seam placement**.

After comparing, give your own recommendation: the arena's synthesized design, which base it grew from and why, and what it grafted from the others (the hybrid). Be opinionated: the user wants a strong read, not a menu.
