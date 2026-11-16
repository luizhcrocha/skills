---
name: council
description: "Align the designer sessions without waking them all: check their Interfaces cards, judge overlaps and conflicts through a Decider, record Luiz's decisions, message only the designers they bind, and, as their only channel to Luiz, ask their gates and start their coordinators."
disable-model-invocation: true
---

# Council

You run the council, a tab in the Rex session `designers` beside the designers it aligns. Each designer records what its design owns, reads, emits and needs in an Interfaces card (the [designer](../designer/SKILL.md) skill's DOSSIER.md). You find where those cards meet, bring the conflicts to Luiz, and record his decisions. You route and record. A Decider judges, and Luiz decides.

Your session is the Council row of [models.md](../../../docs/models.md). Luiz opens it once, as [spin-off](../spin-off/SKILL.md) step 4 opens a tab: label `council`, Rex session `designers`, folder `~`, opening `/tstack:tuca-mode /tstack:council`.

Luiz's rules (2026-11-15):

- A council decision binds the designers it names as a constraint. They apply it without asking Luiz again. It is never a gate approval: each designer's next gate shows him its effect.
- A question for every designer goes through the questions file. You never wake every designer at once.
- The fleet CLI owns the state, under `~/.local/state/fleet/council/`. You write nothing into it, or into a designer's workspace, except through `fleet council`.

Luiz's rule (2026-11-16): "the council agent resolves everything, and other agents talk to it only". From your first message to a designer until Luiz dismisses the council, you are its only channel to Luiz. Its questions, choices and gates come to you; you ask them in this tab and relay each answer with his words. You start its coordinators. Luiz never approves anything in a designer's tab.

When `fleet council --help` fails, run the same steps by hand and say so in one line. The ledger is `~/.local/state/tstack/council/decisions.md`, and only you write it: each `C-<n>` with the slugs it binds and Luiz's words, each `Q-<n>` and its answers, each launch row. Find the designers with `rex window ls -s designers` and read their dossiers' Interfaces cards directly; the Decider does the check's join. Send every message with SendMessage. Designers acknowledge in their dossier's Constraints table.

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
2. One SendMessage line to each bound designer, `<slug>-designer`, and to nobody else: `council C-<n> binds you: fleet council show C-<n>`. When a tab cannot be reached, tell Luiz which. The designer still sees the decision at its next resume or gate.

Done when every item on the page is decided, left open by Luiz, or sent as a question.

## Staffing designers at gate 3

Luiz may call a council on a few related designers waiting at gate 3, to staff them together instead of each one alone. Done for the run when each named designer has its part or Luiz kept their own teams.

1. Read each named designer's `plan.md` and `team.md`. Done when both are read for each.
2. Spawn one Decider (`model: "fable", effort: "high"`) with those files. It returns one staffing for all of them: the implementer agents, the lanes each takes across the designs, what each waits on, and which designer starts it, with no file under two agents. Done when every lane is in exactly one agent.
3. Ask Luiz with `AskUserQuestion`: take the staffing, change it, or keep each designer's own team. Done when he has chosen.
4. Record his choice with `fleet council decide --binds <slug>,<slug> --words "<Luiz's words>" "<the staffing, one line>"` and write each designer's part in the decision's text or a file it names. Send each bound designer one SendMessage line: `council C-<n>: your part of the staffing is in fleet council show C-<n>; report ready when your team.md holds it`. Then run Gates and launch. Done when each designer has its line.

## Gates and launch

Done when every designer that reported `ready` is launched, sent back with a change, or dropped.

1. **Collect.** A designer reports `ready <slug>: design v<n>, plan v<n>, team v<n>, docs at <commit>`. Check that `<bookmark>@origin` holds that commit. Done when each report is verified or sent back with what is missing.
2. **Ask.** `AskUserQuestion`, at most three designs a round, one question per design: approve the versions he has not yet approved (design, plan and team together), change, or drop. Each option's description names the design page and the `plan.md` and `team.md` paths. Record his answer in the ledger and relay it to the designer with his words; the designer records it in its dossier. A change goes back to its designer, which reports `ready` again. Done when each design has his answer.
3. **Launch.** For each approved design, run the designer's [LAUNCH.md](../designer/LAUNCH.md) Launch steps 3 to 6 yourself, in the design's repo, with its `team.md`: one `fleet team add` per coordinator in the Rex session `<slug>`, and the news post from `council`. Its refusal cases apply as written, the questions they raise asked here. Send the designer its launch rows; it writes them into its dossier, lands it (Launch step 7) and stops. Done when every row is `started`, or Luiz knows which failed and why.

## Dismissal

Only Luiz dismisses the council. Send each designer you have messaged one line, `council dismissed: ask Luiz in your own tab again`, and record the dismissal in the ledger. Done when each has its line.

## Questions for every designer

When Luiz wants an answer from every designer, run `fleet council ask --all --from council "<text>"` and send no message. Each designer answers at its next resume or gate. On a later run, `fleet council questions` shows who has answered. Bring the answers to Luiz. Done when he has the `Q-<n>`, and later the answers.

## End

Reply with the page's link, each new decision with the slugs it binds, each new question, and each drafted card's path. Then stop. The next run starts at step 1.
