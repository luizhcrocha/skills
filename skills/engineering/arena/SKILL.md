---
name: arena
description: "Run N parallel attempts at one task under distinct constraints, pick a base, graft the best of the others. Use for \"arena this\" or competing designs of one contested shape."
---

# Arena

Fan out N parallel attempts at the same task, each under a different constraint. Read every candidate end to end. Pick the strongest as the base, graft the best ideas from the others into it, verify the result. Adapted from poteto's pstack (MIT).

Open a todo list with the six phases before launching anything: Frame, Fan out, Cross-judge, Pick, Graft, Verify.

## 1. Frame

Every runner gets the same task, so the brief is the contract.

1. **The artifact.** State what each candidate produces: a design sketch, a module, a document, a script.
2. **The rubric.** State what success looks like for *this* task, then turn it into 3 to 6 concrete, gradeable criteria. The rubric is for the judge and the picker; runners see only the task.
3. **The constraints.** N runners, default 3. Diversity comes from a distinct constraint per runner, all on the same model:
   - A design task (an interface, a module, a seam) takes the constraints from `tstack:codebase-design`'s [DESIGN-IT-TWICE.md](../codebase-design/DESIGN-IT-TWICE.md): minimize the interface, maximize flexibility, optimize for the common caller, and ports & adapters when a dependency crosses the seam.
   - Any other task: write N distinct approaches, each a different whole shape (a different data structure, a different decomposition, a different owner of the hard part), not flavors of one.
4. **The output paths.** Each runner writes to its own place, per Separate Before Serializing Shared State (`tstack:principles`). In a jj repo: `jj workspace add ../<repo>-arena-<n> -r <base> --name arena-<n>`, one per runner, from the same base. Outside a repo: `<scratchpad>/arena-<slug>/candidate-<n>/`.

Done when the artifact, the rubric, N constraints and N output paths are written down.

## 2. Fan out

Spawn all N runners in one message: fresh agents, `model: "opus"`, `run_in_background: true`. Each brief carries the task, pointers to the shared grounding (files, not pasted content), its one constraint, its output path, and an order to produce the artifact and a short rationale naming the alternatives it considered and what it rejected. Tell each runner it is one of several: build the best candidate its constraint allows, and skip hedging toward a safe middle, since the differences between candidates are the signal.

A runner that produces nothing drops out: continue with N-1 and note the dropout. Done when every runner has returned or dropped out.

## 3. Cross-judge

Once every candidate is written, spawn one judge: a fresh agent that ran nothing in this arena, on the default Fable (`model: "fable"`), read-only, in the background (if Fable is unavailable (usage or session limit, credits, a model error), rerun that agent on Opus (`model: "opus"`) and say so in the reply). It gets the rubric and the candidates by neutral labels (A, B, C), without the constraint each ran under, scores each criterion per candidate, and recommends a base with its reason. It runs while you read in step 4.

## 4. Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, then compare with the judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous: read both rationales before deciding.

Pick the candidate a future maintainer can extend most easily without breaking its invariants. When two feel tied, take the cleaner seam or the smaller interface, per the Laziness Protocol.

Done when the pick and its reason, with the judge's verdict, are in the synthesis note.

## 5. Graft

Walk each losing candidate once more for what is worth porting into the base: usually one or two things per candidate, not most of it. Fold each graft in by hand, per Redesign from First Principles, so the result stays coherent under one mental model; pasting whole blocks from a loser breaks that. Record each graft with its source candidate, and each rejection with its reason.

- **Convergence**: the candidates landed on the same shape. That is a strong agreement signal: note it and ship the consensus shape; no graft is needed.
- **Divergence**: the candidates share almost nothing. Step 1 was under-specified: reframe and re-run rather than averaging the divergence.

In a jj repo the grafted result lands in the caller's workspace (the base candidate's change squashed or rebased in, grafts on top), and every `arena-<n>` workspace goes: `jj workspace forget arena-<n>`, then remove its directory, and abandon the candidate changes not kept. Done when the grafts are in and no arena workspace is left.

## 6. Verify

The synthesized artifact holds up under the same scrutiny as any other output, per Prove It Works: run it, test it, read the real output. A problem the arena missed means step 1 was wrong (reframe and re-run) or one candidate caught it and the graft was missed (back to step 5); fix the cause rather than patching over it.

## Output

One synthesized artifact, and beside it a short **synthesis note**: the base and why, the judge's verdict, each graft with its source candidate, the rejections with reasons, convergence or divergence, dropouts, and the verification result.
