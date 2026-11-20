---
name: architect
description: "Sketch types, signatures and the module map from competing candidates before code, then implement against it. Use for \"architect this\", \"design this first\", \"sketch the types\", or non-trivial work."
---

# Architect

Before writing code, trace every system the change touches, then sketch two different shapes for it (types, signatures, module boundaries) and pick the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. Redesign instead of patching if workarounds repeat.

For a large or contested design, run the **arena** skill instead of sketching alone.

Local changes (tstack): [local/architect.md](../../../local/architect.md)
