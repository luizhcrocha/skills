---
description: "Explain how code works, as onboarding a senior engineer. Use for \"how does X work\", \"zoom out\", a map of an area, unfamiliar code before a change, or \"where should this live\"."
disable-model-invocation: ~
---

- Read `CONTEXT.md` and the area's ADRs first, and use their names. "Zoom out" (map the modules and callers around this) is a how question.
- The subagent is an `Explore` agent in the Researcher role ([models.md](../docs/models.md)), in the background. For a subsystem that spans files or services, spawn 2 to 4 of them in one message, one per angle (entry points, data model, a boundary, failure paths), then one explainer over their findings; it moves up a role when they contradict or the question asks for design judgement ("is this the right layer").
- A walkthrough that needs several diagrams goes to `tstack:show-me` as a page.
- A non-obvious gotcha the answer surfaces becomes a memo note when it passes memo's admission rule (`tstack:memo`).
