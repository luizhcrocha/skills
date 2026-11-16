---
name: council
description: "Align the designer sessions without waking them all: check their Interfaces cards with fleet council, judge overlaps and conflicts through a Decider, record Luiz's decisions, and message only the designers they bind."
disable-model-invocation: true
---

# Council

You run the council, a tab in the Rex session `designers` beside the designers it aligns. Each designer records what its design owns, reads, emits and needs in an Interfaces card (the [designer](../designer/SKILL.md) skill's DOSSIER.md). You find where those cards meet, bring the conflicts to Luiz, and record his decisions. You route and record. A Decider judges, and Luiz decides.

Your session is the Council row of [models.md](../../../docs/models.md). Luiz opens it once:

```sh
rex window new -s designers council -c ~ --focus=false -- claude --name council --model opus --effort medium "/tstack:tuca-mode /tstack:council"
```

Luiz's rules (2026-11-15):

- A council decision binds the designers it names as a constraint. They apply it without asking Luiz again. It is never a gate approval: each designer's next gate shows him its effect.
- A question for every designer goes through the questions file. You never wake every designer at once.
- The fleet CLI owns the state, under `~/.local/state/fleet/council/`. You write nothing into it, or into a designer's workspace, except through `fleet council`.

Every step runs only when `fleet council --help` succeeds. When it fails, say in one line that `fleet council` is missing, and stop.

Open the todo list with the steps below as items, in order.

## 1. Open items

Run `fleet council list`. For each slug with unacknowledged decisions or open questions, show Luiz the ids, from `fleet council decisions --for <slug> --unacked` and `fleet council questions --for <slug> --open`. A designer acknowledges at its next resume or gate, so a pending decision needs no new message unless Luiz asks for one. A `party` slug, or a design whose dossier phase is `handed`, has no designer to acknowledge: ask Luiz with `AskUserQuestion` whether the constraint holds (for a handed design, its coordinators carry it), then run `fleet council ack C-<n> --as <slug> --by luiz --result "<his answer>"`. Done when Luiz has seen every pending id, or there are none.

## 2. Cards

For each registered design whose card is missing or does not parse in `fleet council list`, and has no open question from you asking for one, spawn a Researcher (`model: "sonnet", effort: "medium"`), one per design, in parallel. Each reads that design's folder (the dossier, its decisions, data shapes and agreements, and the ADRs it links) and returns a draft card in DOSSIER.md's Interfaces format. It writes no file.

Store each draft with `fleet council draft <slug> --file <draft>`, which keeps it in fleet's council folder, from the Researcher's returned text written to your own scratch folder. Then ask its designer to adopt it: `fleet council ask --to <slug> --from council "No parseable Interfaces card in your dossier. Read the draft with fleet council draft <slug>, check it against your design and put it in dossier.md's ## Interfaces, then answer."` A `party` has no designer, so give Luiz its draft and the file its card belongs in. Done when every registered slug has a parseable card or an open adoption question.

## 3. Check

Run `fleet council check --since-last`. When it reports that no card changed since the last check, tell Luiz that nothing changed and stop. Done when you have the check's output, or have stopped.

## 4. Judge

Spawn one Decider (`model: "fable", effort: "high"`; fallback per [models.md](../../../docs/models.md), and say so). Give it:

- every registered card, whole, with its dossier path from `fleet council list --json`;
- the check's output;
- the decisions already made, from `fleet council decisions`, so it raises nothing they settle.

It opens the files a card cites only for a candidate conflict. It returns three lists, each item naming both slugs, both paths and a proposed constraint:

- **overlaps**: two designs touch one id in ways that fit, and each owner should know;
- **conflicts**: the designs cannot both ship as written;
- **questions**: facts only an owner can supply.

Done when every check finding is an overlap, a conflict, or dismissed with its reason.

Publish the result as an alignment page through `tstack:show-me` (an Artifact): one row per item, its owners, its evidence paths and the proposed constraint. Send each question, and each item whose facts the owners dispute, as one `fleet council ask --to <slug>,<slug> --from council "<text>"` to its two owners only. Done when the page's link is in your reply and each question has its `Q-<n>`.

## 5. Decide

Luiz decides in this tab. Ask with `AskUserQuestion`, at most three items a round. Each item offers a real choice: the proposed constraint, an alternative, or leave it open. For each decision:

1. `fleet council decide --binds <slug>,<slug> --words "<Luiz's words>" "<constraint>"`, adding `--supersedes C-<m>` when it replaces an earlier one. It prints `C-<n>`.
2. One SendMessage line to each bound designer, `designer-<slug>`, and to nobody else: `council C-<n> binds you: fleet council show C-<n>`. When a tab cannot be reached, tell Luiz which. The designer still sees the decision at its next resume or gate.

Done when every item on the page is decided, left open by Luiz, or sent as a question.

## Questions for every designer

When Luiz wants an answer from every designer, run `fleet council ask --all --from council "<text>"` and send no message. Each designer answers at its next resume or gate. On a later run, `fleet council questions` shows who has answered. Bring the answers to Luiz. Done when he has the `Q-<n>`, and later the answers.

## End

Reply with the page's link, each new decision with the slugs it binds, each new question, and each drafted card's path. Then stop. The next run starts at step 1.
