---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

If the next session must wait for other work to land, name each change it waits on by its full id (`jj log -r <rev> -T change_id`; a short id stops resolving once the change is hidden) and make its first step `fleet msg wait landed <id>`, which returns at once for a change already landed.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

Names here: ADRs → none: tstack keeps no ADRs (Luiz, 2026-11-20); a decision goes to memo or the change's description
