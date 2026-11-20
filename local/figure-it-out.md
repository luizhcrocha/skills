---
description: "Design an auditable bespoke playbook when no tuca-mode playbook fits. Use for \"figure it out\", a large migration or port, a cross-cutting change, or unattended work."
disable-model-invocation: ~
---

- Start from tuca-mode's Principles section and the `tstack:principles` index. Ground with `tstack:how` and `tstack:recall`.
- Each unit is a described jj change; `jj abandon` a failed experiment. Parallel lanes are Implementers ([models.md](../docs/models.md)) in their own jj workspaces (`ws-add <lane> -r <base>`); a batch of independent lanes goes through `tstack:swarm`.
- Log with `tstack:show-me-your-work`; land through tuca-mode's Land playbook. Work outside this session's task goes to `tstack:spin-off`.
