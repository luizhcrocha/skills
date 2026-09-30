---
name: figure-it-out
description: Design an auditable bespoke playbook when no tuca-mode playbook fits: frame, workflow, hypothesis loop, decision trail, verify. Use for "figure it out", a large migration or port, an ambitious multi-part or cross-cutting change, or work Luiz reviews after stepping away.
---

# Figure it out

When the task matches no playbook, design one. The deliverable before any code is the workflow itself: a sequence of phases that scales rigor to the task, runs the scientific method, and leaves a decision trail Luiz can audit after stepping away. Adapted from poteto's pstack (MIT).

## Start

Open a todo list whose first item is to read the Principles section of tuca-mode (`${CLAUDE_PLUGIN_ROOT}/skills/engineering/tuca-mode/SKILL.md`) and the `tstack:principles` index. Then add the phases below as todos.

## Phase A: Frame

Ground first, then commit. Map the ground with `tstack:how` when it is unfamiliar, and `tstack:recall` for what earlier sessions decided. Don't start the run until you can state:

- The definition of done as a falsifiable predicate (Prove It Works).
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced.
- The rigor level, biased high. One-way doors and high blast radius get more. Reversible low-stakes steps get less. Rigor is gates and artifacts, not "try harder".

Present the framing and tradeoffs before committing to a long run. Reversible work proceeds (Never Block on the Human), but a multi-hour run earns one checkpoint with Luiz.

## Phase B: Design the workflow

Decompose into atomic, independently-landable units: each one a described jj change. Sequence riskiest-unknown-first. Scaffold and verification come before features (Foundational Thinking).

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
- For one-way-door design decisions, design it twice with `tstack:codebase-design` (its DESIGN-IT-TWICE.md), or two Opus agents in separate jj workspaces build competing shapes and you pick or graft. Skip it for mechanical work whose shape is already concrete. A second round over a settled design is over-engineering (Laziness Protocol).
- Decide what fans out. Parallelize only across seams, and give each worker its own jj workspace (`jj workspace add ../<repo>-<lane> -r <base> --name <lane>`, per tuca-mode's Subagents section; Separate Before Serializing Shared State). Don't over-fan; a batch of independent lanes goes through `tstack:orchestrate`.
- Write the designed phase list down. That list is what Luiz reviews.

Then execute the design. Add its steps to the todo list as concrete items, after the Phase C entry and before Phase D. Run each under the Phase C loop discipline, and weave the Phase D log through them, a row as each step lands, rather than saving the whole trail for the end.

## Phase C: Run the loop

Each unit is an experiment. State the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it as a described jj change if it advanced, `jj abandon` it if it didn't. Verify each unit before starting the next instead of batching checks at the end (Sequence Work into Verifiable Units).

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
- Pair delegated work with a judge: read the worker's diff yourself, or a fresh Opus reviewer does. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix the gate in its own change rather than routing around it.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Don't hide a negative.

## Phase D: Keep the audit trail

Log the run with `tstack:show-me-your-work`. figure-it-out's work is usually ambitious enough to commit the trail, so Luiz can read it next to the stack. The trail plus the diff is what lets him come back and trust the work.

## Phase E: Verify and hand back

Check the whole against the Phase A predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script (Encode Lessons in Structure). Code that should land runs tuca-mode's Land playbook.

**Reply:** the playbook you designed, the rigor level and why, the decision-trail path, what's verified against the predicate, and what's still open, ending with show-me-your-work's Attention section.
