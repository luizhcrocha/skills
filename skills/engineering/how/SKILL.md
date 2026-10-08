---
name: how
description: "Explain how code works, as onboarding a senior engineer. Use for \"how does X work\", \"zoom out\", a map of an area, a walkthrough before changing unfamiliar code, or \"where should this live\"."
---

# How

Answer "how does X work?" with an explanation a senior engineer new to the area can build a working mental model from: enough to start working in it confidently, not annotated source code. Adapted from poteto's pstack (MIT).

Use the project's own vocabulary: read `CONTEXT.md` (if it exists) and the ADRs in the area, and name things the way they do. Motivation ("why was it built this way?") is the `why` skill's question.

## 1. Size the question

If the scope is ambiguous, state your reading of it and explore; the user can redirect.

- **Simple**: one module, a small utility, a narrow question, or "zoom out: map the modules and callers around this". One pass, step 2.
- **Complex**: a subsystem spanning files or services, a cross-cutting feature, a full architectural overview. Explore in parallel first, step 3.

When in doubt, take the simple path.

## 2. Simple: one pass

Spawn one `Explore` agent playing the Researcher role ([MODELS.md](../../productivity/coordinator/MODELS.md)), in the background, with the brief in [references/explainer-prompt.md](references/explainer-prompt.md) minus its explorer-findings section: it explores and explains in one pass. Go to step 5.

## 3. Complex: explore

Split the question into 2 to 4 exploration angles, each a distinct slice of the subsystem (the entry points, the data model, the boundary with X, the failure paths). Spawn all explorers in one message: `Explore` agents playing the Researcher role, in the background, each with [references/explorer-prompt.md](references/explorer-prompt.md) and its angle filled in.

## 4. Complex: explain

When every explorer has returned, spawn one explainer, a Composer, with [references/explainer-prompt.md](references/explainer-prompt.md) and all findings filled in. It moves up as MODELS.md says when the findings contradict each other. The same move applies when the findings leave gaps it must close by reading code, or when the question asks for a judgement about the design ("is this the right layer").

## 5. Present

Present the explainer's output with light edits for clarity or context from the conversation; don't rewrite it. The sections, dropping any that don't apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas. Diagrams are mermaid, only where they clarify; a walkthrough that needs several diagrams built up one after another goes to the `show-me` skill as a page.

## 6. Keep the gotchas

Every non-obvious Gotcha the explanation surfaced (surprising behavior, a trap, a historical artifact that still bites) becomes a memo note of kind `gotcha` (the `memo` skill), one self-contained line each, unless memo already has it. The explanation itself stays in the chat.
