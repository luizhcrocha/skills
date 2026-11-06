# Grillings and links

Read from the coordinator's [SKILL.md](SKILL.md) before you open, revise or close a grilling, and before you record a link.

## Grillings

A **grilling** (the `grilling` or `grill-me` skill, or any round of questions to settle a design) runs on the page, never as chat messages: `fleet state <dir> grill <id>` with one `--ask` per question and its options as `--option`.

Each question is a small decision, written as one. Luiz, on a dense one: "is dense, hard to answer like this", "i was lost reading this question".

- **The title** is a whole plain phrase ("Where the legal terms live"), never a fragment.
- **The question** is one plain question that names the thing in plain words ("Should the list of legal terms, and the decisions about them, stay in Postgres or move to the graph database (Neo4j)?"), never a table name as its subject, and never its options in prose.
- **Options**: two to four (`--option "Q1 a: label | consequence"`), each a few words and one line on what that means for the user. The page shows them as cards.
- **The recommendation** names an option by its id (`a`), with a one-sentence reason that says the trade-off in plain words first ("Today one save updates the terms safely in one step; splitting them across two databases means a save can half-succeed"). Files and lines, ADR and decision numbers and internal terms go after that sentence, or in the body, never in it: the CLI warns on a source in the reason's first sentence, and on a reason over 200 characters.
- **Shared context** and any picture go in the grilling's `--body`, shown once above the first question as The context, by the show-me triggers ([DECISIONS.md](DECISIONS.md#writing-a-card)): a question about where data lives, a flow or an architecture gets the diagram of the parts.
- For an **architecture question**, the body says the what and the how of each option, as a decision's plan does: the module, where it runs, what it stores, who builds it.
- The same naming rules as a decision's: no worker's id, every internal name glossed, a case id with its name.
- The grilling's own title, why and context change with `--title`, `--why`, `--body` on the open grilling, with `--log "what changed"`. The `grilling` skill's "On a fleet dashboard" says how rounds, follow-ups, answers, and the end are recorded. A confirmation after the last answer (a recap, the advisor's amendments) is one more question of the grilling (`grill <id> --ask`), answerable on the page, never a chat message asking for "confirm". Once every question is answered, record the grilling at once (`grill <id> --done "what was agreed"`, or `decision <id> --withdraw "why"`): until then it waits on you, not on the user, and `fleet state` says so at every command.

## Links

A **link** names a place the user opens: `fleet state <dir> link <id> --url <address> --title "<what it is>" --kind <kind> [--for "<what the user does there>"] [--decision D12]`. Record every server and page a worker builds for the user, from the worker's report, as one of five kinds, so Luiz recognises it on the Links page:

- `preview`: the fleet's live app (`fleet preview`, or the one dev server the user tests on). A fleet has one; a second build of the app is a prototype or is dropped.
- `prototype`: a throwaway sketch or a round of one. Name the round in the title ("Map, round 14").
- `doc`: a design note, a report, a claude.ai artifact. A file on this machine is only on this machine: publish what Luiz must read elsewhere (an artifact).
- `tool`: a page the user works in (marking gold, confirming cuts). Give it `--for "mark each decision"`.
- `service`: a lab or infra endpoint (lakeFS, a queue's console).

The title is plain words for the place, never a worker's id or name (`fleet state` warns, as it does for decisions): "Auth architecture review", not "Auth review (b290)". `--for` says what Luiz does there ("review and mark", "read", "try"); `--decision` ties it to the open decision it serves, so the decision's page opens it. Both put it under "Needs you" on the Links page. When it ends (the round is over, the server is stopped, the decision is closed), mark it `link <id> --done`: it moves to Inactive and stays findable; `--drop "why"` only for a link recorded by mistake. The Links page shows each one active or not: the page probes every address on this machine and the tailnet, and a link whose server is down, whose decision is closed, or that is done is inactive.
