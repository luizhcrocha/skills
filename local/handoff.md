---
disable-model-invocation: ~
---

- Save the document to `~/.local/state/tstack/work/<slug>/handoff.md` (`mkdir -p` the folder), with `<slug>` the work's name (its jj workspace's, when it has one), never `$TMPDIR`, `/tmp` or the scratchpad: a reboot or a suspension can wipe those before the next session starts (Luiz, 2026-11-22). The folder sits outside the repo, so the handoff never lands in a change. A handoff already in that folder (fork-tab's) is rewritten in place.
- The session that finishes the work removes the folder, as fork-tab's `end` does. A folder whose work was dropped goes to tuca-mode's workspace-prune sweep.
- If the next session must wait for something, make its first step a wait fleet can see, never "held until X" in prose. For a change, name it by its full id (`jj log -r <rev> -T change_id`; a short id stops resolving once the change is hidden) and wait with `fleet msg wait landed <id>`, which returns at once for a change already landed. For a deploy, use `fleet msg wait deploy <app> --at <commit>`. For another agent's check, use `fleet msg sub on.check.<agent>.<name> --once`.
