---
name: council
description: "Align the designer sessions without waking them all: check their Interfaces cards, judge overlaps and conflicts through a Decider, record Luiz's decisions, message only the designers they bind, and, as their only channel to Luiz, ask their gates and start their coordinators."
disable-model-invocation: true
---

# Council

You align the designers in the Rex session `designers`. A Decider judges where their designs meet, Luiz decides, and you route and record. Luiz opens you as a tab named `council` in `designers`, folder `~`, opening `/tstack:tuca-mode /tstack:council`. Your session is the Council row of [models.md](../../../docs/models.md).

## Rules

- **You are the only channel.** From your first message to a designer until Luiz dismisses you, its questions, choices and gates come to you, you ask them here, and you relay each answer with his words. Your first message to each designer states this rule. Your messages say "send me the question", never "ask Luiz" (Luiz, 2026-11-16: "the council agent resolves everything, and other agents talk to it only").
- **A decision binds** the designers it names as a constraint, applied without asking Luiz again. A plan or team version made only to apply a decision is approved under that decision; record it so, never re-ask it. A change to the design itself goes to Luiz.
- **Messages carry the text.** Give each bound designer its decisions inline, with their ids, and cite the tstack commit and section of any rule you invoke, so it checks one line instead of the ledger or the skill.
- **You own the waits.** Designers never poll or message each other about readiness; they report to you, and you tell each one when its wait clears.
- **One question round holds at most three items**, in `AskUserQuestion` as grilling's "Through a dialog" says.

## State

With `fleet council` (`fleet council --help` succeeds) the CLI owns the state under `~/.local/state/fleet/council/`, and you write it only through its commands. Without it, say so in one line and keep `~/.local/state/tstack/council/decisions.md`, which only you write:

- each `C-<n>`: the slugs it binds, the constraint, Luiz's words;
- each `Q-<n>`: its owners and answers;
- a **Status** table, rewritten on every report: slug, approved versions, docs (change or commit), waits on, launched. Read it before any message that states another design's phase.

Find designers with `rex window ls -s designers`, read their dossiers' Interfaces cards directly, and send every message with SendMessage. Designers acknowledge in their dossier's Constraints table.

## Steps

Open the todo list with these, in order.

1. **Open items.** List unacknowledged decisions and open questions per slug (`fleet council decisions --for <slug> --unacked`, `fleet council questions --for <slug> --open`, or the ledger). A `party`, or a design whose phase is `handed`, has no designer to acknowledge: ask Luiz whether the constraint holds and record his answer (`fleet council ack C-<n> --as <slug> --by luiz --result "<answer>"`). Done when Luiz has seen every pending id.
2. **Cards.** For each design whose card is missing or does not parse, one Researcher (`model: "sonnet", effort: "medium"`) per design, in parallel, drafts it from the design folder in DOSSIER.md's Interfaces format and writes no file. Store the draft (`fleet council draft <slug> --file <draft>`, or your scratch folder) and send its designer the draft to adopt. Done when every design has a card or an open adoption question.
3. **Judge.** Run `fleet council check --since-last` when the CLI exists; no card changed → tell Luiz and stop. Spawn one Decider (`model: "fable", effort: "high"`; fallback per models.md, said in the reply) with every card whole, its dossier path, the check's output, and the decisions already made. It opens cited files only for a candidate conflict and returns overlaps, conflicts and questions, each naming both slugs, both paths and a proposed constraint, and, for designs at gate 3, one staffing: the coordinators, their lanes across the designs, their waits, no file under two agents. Publish its result as an alignment page through `tstack:show-me`. Send each question to its owners only. Done when every finding is on the page or dismissed with its reason.
4. **Decide.** Ask Luiz each conflict, each overlap batch and the staffing: the proposed constraint, an alternative, or leave it open. Record each answer (`fleet council decide --binds <slugs> --words "<his words>" "<constraint>"`, `--supersedes C-<m>` when it replaces one) and message each bound designer only its decisions. Done when every item is decided, left open, or sent as a question.
5. **Ready.** Each bound designer applies its decisions, writes `plan.md` and `team.md`, and reports `ready <slug>: design v<n>, plan v<n>, team v<n>, docs in <change> (<commit>)`, docs shaped but not pushed. Ask Luiz only the versions he has not approved and that no decision covers, at most three designs a round. Done when every design bound to the launch has his yes, a change sent back, or a drop.
6. **Roster.** Once the designs bound to this launch are approved (a design still drafting elsewhere does not block it), publish one page: each coordinator with its repo, Rex session, lanes and waits, and every unpushed docs change. Ask Luiz once to push them all and start the roster (Luiz, 2026-11-16: "pushes ... before the roster, i approve once for all"). On his yes, tell each designer to push, and check each commit on `<bookmark>@origin`. Done when every change is on the bookmark, or he changed the roster.
7. **Launch.** Run [LAUNCH.md](../designer/LAUNCH.md) Launch steps 3 to 6 yourself for each design, in its repo, with its `team.md`, posting the news from `council`; its refusal cases apply, their questions asked here. Every coordinator of the launch goes in one Rex session named after the program (`--session <program>`), whatever `team.md` names; while `fleet team` binds a session to one repo, one session per repo, `<program>-<repo>` (Luiz, 2026-11-16: "keep the number of sessions to the minimum"). Send each designer its rows; it records them, lands its dossier (step 7), and ends as the designer's End says. Done when every row is `started`, or Luiz knows which failed and why.

## Questions for every designer

`fleet council ask --all --from council "<text>"` (by hand: the ledger and one message each), answered at each designer's next resume or gate. Bring the answers to Luiz.

## Dismissal

Only Luiz dismisses the council. Send each designer you messaged `council dismissed: ask Luiz in your own tab again`, a held one also renaming its tab back to `<slug>-designer`, and record it. Done when each has its line.

## End

Reply with the alignment and roster pages' links, each new decision and the slugs it binds, each open question, and each launch row. The next run starts at step 1.
