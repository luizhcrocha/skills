---
name: how
description: Explain how code works, at the level of a senior engineer onboarding onto a subsystem. Use for "how does X work", "zoom out", "give me a map of this area", a walkthrough before changing unfamiliar code, and placement or ownership questions ("where should this live", "which module owns this", "is this the right layer").
---

# How

Answer "how does X work?" with an explanation a senior engineer new to the area can build a working mental model from: enough to start working in it confidently, not annotated source code. Adapted from poteto's pstack (MIT).

Use the project's own vocabulary: read `CONTEXT.md` (if it exists) and the ADRs in the area, and name things the way they do. For motivation ("why was it built this way?"), read the history instead (`jj log`, `jj file annotate`, `recall`).

## 1. Size the question

If the scope is ambiguous, state your reading of it and explore; the user can redirect.

- **Simple**: one module, a small utility, a narrow question, or "zoom out: map the modules and callers around this". One pass, step 2.
- **Complex**: a subsystem spanning files or services, a cross-cutting feature, a full architectural overview. Explore in parallel first, step 3.

When in doubt, take the simple path.

## 2. Simple: one pass

Spawn one `Explore` agent on the default Sonnet (`model: "sonnet"`), in the background, with the brief in [references/explainer-prompt.md](references/explainer-prompt.md) minus its explorer-findings section: it explores and explains in one pass. Go to step 5.

## 3. Complex: explore

Split the question into 2 to 4 exploration angles, each a distinct slice of the subsystem (the entry points, the data model, the boundary with X, the failure paths). Spawn all explorers in one message: `Explore` agents on the default Sonnet (`model: "sonnet"`), in the background, each with [references/explorer-prompt.md](references/explorer-prompt.md) and its angle filled in.

## 4. Complex: explain

When every explorer has returned, spawn one explainer with [references/explainer-prompt.md](references/explainer-prompt.md) and all findings filled in. Default Sonnet. Use the default Opus (`model: "opus"`) when the findings contradict each other, leave gaps the explainer must close by reading code, or the question asks for a judgement about the design ("is this the right layer").

## 5. Present

Present the explainer's output with light edits for clarity or context from the conversation; don't rewrite it. The sections, dropping any that don't apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas. Diagrams are mermaid, only where they clarify; a walkthrough that needs several diagrams built up one after another goes to the `show-me` skill as a page.

## 6. Keep the gotchas

Every non-obvious Gotcha the explanation surfaced (surprising behavior, a trap, a historical artifact that still bites) becomes a memo note of kind `gotcha` (the `memo` skill), one self-contained line each, unless memo already has it. The explanation itself stays in the chat.
