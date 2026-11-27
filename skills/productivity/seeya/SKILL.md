---
name: seeya
description: "Suspend this session to come back to later: check for undone work, stop its processes and subagents, tell work-graph and the agents that depend on it, clean up, then fleet suspend me. Use for /seeya, or when Luiz or a handoff says to suspend once done."
---

# See ya

Luiz wants this session put away and kept for later. Run [`/bye`](../bye/SKILL.md)'s steps 1 to 4 (undone work waits for his answer there too), then suspend instead of closing:

5. **Suspend.** Write the final reply first: what stopped, who was told, and what was left and where. Then run `fleet suspend me --why "<the handoff line from bye's step 3>"`. Fleet suspends the session once this turn ends, closes its tab, and keeps the conversation for `fleet resume`. The `--why` text is what the session reads when it comes back. Without `fleet` on PATH, say the work is wound down and the session is ready to close.
