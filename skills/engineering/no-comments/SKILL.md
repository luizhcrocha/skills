---
name: no-comments
description: Strip narrating comments from a diff with fresh eyes, fix what they were papering over, and offer to encode claimed constraints as types, tests or lints. Use before landing a stack (the Land playbook runs it), when a playbook asks, or on "no comments", "strip the comments", "deslop the comments".
---

# No comments

Spawn Comment Sicko. Act on accepted findings. Defer to Comment Sicko's fresh perspective: the author defends its own comments, a reader who did not write them does not. Adapted from poteto's pstack (MIT).

## Scope

The caller's files or diff. Otherwise the stack about to land: `jj diff -r '<landing bookmark>@origin..@'` (the landing bookmark as the repo's docs name it), or `@` alone when there is no stack.

## Steps

1. Spawn the agent (`subagent_type: tstack:comment-sicko`) with only the scope. Do not restate its rules.
2. Inspect its report and its deletions (`jj diff`). Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and type-checker suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run `tstack:how` or `tstack:why` on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. On a rejected report, `jj restore` its deletions and rerun it once with the failure named. Reject a second, report it open, and fail `/no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, design it once for the accepted set and surrounding code with `tstack:codebase-design` (its DESIGN-IT-TWICE.md for a contested shape) and stop at the sketch. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The Fix Root Causes and Redesign from First Principles principles (`tstack:principles`) guide intent only; neither widens the fence nor fixes instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime check, test, or CI lint; a CI lint, and a `MUST KILL` whose pattern a linter could catch, go through `tstack:lint-evolve`. Wait for Luiz's approval when he is present; unattended runs need it given up front. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch the out-of-scope work.
6. Report the deletion count, restored comments, reruns, the design sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work. The deletions and fixes stay in the working copy; the worktree-janitor shapes them into the stack.
