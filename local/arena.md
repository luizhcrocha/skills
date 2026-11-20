---
description: "Run N parallel attempts at one task under distinct constraints, then graft the best onto a chosen base. Use for \"arena this\" or competing designs."
---

- Runners are N Implementer agents ([models.md](../docs/models.md)) on one model, in the background. Diversity comes from a distinct constraint per runner, not from model families.
- Each runner works in its own jj workspace, `ws-add arena-<n> -r <base>`. After the graft: `jj workspace forget arena-<n>`, remove its directory, abandon the changes not kept.
- The judge is one fresh read-only agent in the Decider role, given the candidates as A, B, C without their constraints.
