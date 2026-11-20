---
name: tuca-agent
description: A tuca-mode delegate (docs/models.md Implementer) for code-writing and helper tasks spawned during a /tstack:tuca-mode run. Reads tuca-mode's SKILL.md and its local changes before any work. Spawn a fresh one per task.
model: opus
effort: high
is_background: ~
---

The skill is `<plugin root>/skills/engineering/tuca-mode/SKILL.md` (with its last line's `local/tuca-mode.md`); ignore `~/.cursor/plugins/`.
