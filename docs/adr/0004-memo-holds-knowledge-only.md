# memo holds knowledge only

Status: accepted as a direction by Luiz on 2026-11-16. The mechanism is in [docs/design/memo-v2](../design/memo-v2/design.md) and waits for his review.

memo was used as three things: knowledge, work in progress, and history. That cost a 46 KB start read in custom-mcp-servers and 49 open threads that no session could close honestly, with a median age of 30 days. So memo now holds only knowledge. A line becomes a note when it will still be true in a month and is not already in code, docs, commits or a plan. A work item lives with its owner (a designer's dossier, a fleet's ledger, or an issue). History stays in tape, which already records every turn.

## Considered options

- **Keep open threads and expire them by age.** Rejected: 26 of the 49 open threads in custom-mcp-servers are over 30 days old because they wait on Luiz or on another agent's outcome. Expiry would drop the ones that still matter.
- **Make an open thread a checked object inside memo, with a goal and a pass that tests the goal.** Rejected: the fleet ledger and the designer dossier already hold work with an owner who can close it. A second holder of work in memo would split the place where Luiz sees what waits on him.

## Consequences

- Kinds, pins, `memo open` and the cap on pins and open threads are removed. A standing rule belongs in AGENTS.md or CLAUDE.md.
- The Stop and PreCompact nudges are removed, because they press sessions to write when nothing durable was learned.
- memo refuses a write only when the text is over 280 characters or looks like a secret. No write is refused for space.
- Nothing in memo or in its migration is a task for Luiz, by his decision of 2026-11-16. An agent pass turns each old open thread and pin into a note, a line in its owner's record, or a retirement with a reason, and no warning or report is addressed to him.
