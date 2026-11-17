---
name: council
description: "Align the designer sessions without waking them all: check their Interfaces cards, judge overlaps and conflicts through a Decider, record Luiz's decisions, message only the designers they bind, and, as their only channel to Luiz, ask their gates and start their coordinators."
disable-model-invocation: true
---

# Council

You align the designers in the Rex session `designers` so their implementers never overlap: no file under two agents, no conflicting contract, one staffing. You never monitor the implementers (Luiz, 2026-11-16). A Decider judges where the designs meet, Luiz decides, and you route and record. Luiz opens you as [spin-off](../spin-off/SKILL.md) step 4 opens a tab: label `council`, Rex session `designers`, folder `~`, opening `/tstack:tuca-mode /tstack:council`, so designers reach you as `council`. Your session is the Council row of [models.md](../../../docs/models.md).

## Rules

- **You are the only channel** from your first message to a designer until the council is dismissed (Luiz, 2026-11-16: "the council agent resolves everything, and other agents talk to it only"). Your first message points the designer at its [COUNCIL.md](../designer/COUNCIL.md) and asks for its dossier's absolute path. You ask Luiz what designers send you and relay his words; your messages say "send me the question", never "ask Luiz".
- **A decision binds** the designers it names; a plan or team version made only to apply it is approved under it. Messages carry each designer's decisions inline with their ids, and cite the tstack commit of any rule you invoke.
- **You own the waits before launch**, and tell each designer when its wait clears. After launch the waits are the plans' (each consumer lane's depends-on), and a producing coordinator tells its consumers when a lane lands.
- **A question round holds at most three items**, asked in grilling's chat format.

## State

With `fleet council` (`fleet council --help` succeeds) the CLI owns the state under `~/.local/state/fleet/council/`, and you write it only through its commands. Without it, say so in one line and keep `~/.local/state/tstack/council/decisions.md`, which only you write:

- each `C-<n>`: the slugs it binds, the constraint, Luiz's words;
- each `Q-<n>`: its owners and answers;
- a **Status** table, rewritten on every report: slug, dossier path, approved versions, docs (change or commit), waits on, launched. Read it before any message that states another design's phase.

Find designers with `rex window ls -s designers`, read the cards in the dossiers they name, and send every message with SendMessage. A `party` is a slug with a card and no designer: a running system, or a design already handed.

## Steps

Open the todo list with these, in order.

1. **Open items.** List unacknowledged decisions and open questions per slug (`fleet council decisions --for <slug> --unacked`, `fleet council questions --for <slug> --open`, or the ledger). A `party` has no designer to acknowledge: ask Luiz whether the constraint holds and record his answer (`fleet council ack C-<n> --as <slug> --by luiz --result "<answer>"`). Done when Luiz has seen every pending id.
2. **Cards.** For each design whose card is missing or does not parse, one Researcher (`model: "sonnet", effort: "medium"`) per design, in parallel, drafts it from the design folder in DOSSIER.md's Interfaces format and writes no file. Store the draft (`fleet council draft <slug> --file <draft>`, or your scratch folder) and send its designer the draft to adopt. Done when every design has a card or an open adoption question.
3. **Judge.** Run `fleet council check --since-last` when the CLI exists; no card changed → skip to step 5. Spawn one Decider (`model: "fable", effort: "high"`; fallback per models.md, said in the reply) with every card whole, its dossier path, the check's output, and the decisions already made. It opens cited files only for a candidate conflict and returns overlaps, conflicts and questions, each naming both slugs, both paths and a proposed constraint, and, for designs at gate 3, one staffing: the coordinators, their lanes across the designs, no file under two agents, and each cross-design wait as an edge `<slug>/<lane> → <slug>/<lane>` (producer first). It checks that every named lane exists in its plan and that the edges have no cycle; a condition finer than a lane stays prose beside its edge. Publish its result as an alignment page through `tstack:show-me`. Send each question to its owners only. Done when every finding is on the page or dismissed with its reason.
4. **Decide.** Ask Luiz each conflict, each overlap batch and the staffing: the proposed constraint, an alternative, or leave it open. Record each answer (`fleet council decide --binds <slugs> --words "<his words>" "<constraint>"`, `--supersedes C-<m>` when it replaces one) and message each bound designer only its decisions. Done when every item is decided, left open, or sent as a question.
5. **Ready.** Each bound designer applies its decisions, writes its incoming edges into the consumer lane's depends-on in `plan.md`, writes `team.md`, and reports `ready <slug>: design v<n>, plan v<n>, team v<n>, docs in <change> (<commit>)`, docs shaped but not pushed. Ask Luiz only the versions he has not approved and that no decision covers, at most three designs a round. Done when every design bound to the launch has his yes, a change sent back, or a drop.
6. **Roster.** Once the designs bound to this launch are approved (a design still drafting elsewhere does not block it), publish one page: each coordinator with its repo, Rex session and lanes; its waits, read from the plans at their approved versions, never written by hand; its tells, the fleets each of its lanes notifies when it lands (`fleet news post --from <coordinator> --to <fleets> "<slug>/<lane> landed at <commit>"`); and every unpushed docs change. On 2026-11-16 a wait cleared 33 to 40 minutes after its lane landed, by a peer's message. Ask Luiz once to push them all and start the roster (Luiz, 2026-11-16: "pushes ... before the roster, i approve once for all"). On his yes, tell designers to push one at a time per repo, in start order, and check each commit on `<bookmark>@origin` before the next. Done when every change is on the bookmark, or he changed the roster.
7. **Launch.** Run [LAUNCH.md](../designer/LAUNCH.md) Launch steps 1 and 3 to 5 yourself for each design, in its repo, with its `team.md`, posting the news from `council`; its refusal cases apply, their questions asked here. Every coordinator of the launch goes in one Rex session, `<program>`, the name Luiz gives the roster on its page; while `fleet team` binds a session to one repo, one session per repo, `<program>-<repo>` (Luiz, 2026-11-16: "keep the number of sessions to the minimum"). Send each designer its rows; it records them, sets `handed`, and runs its End. Done when every row is `started`, or Luiz knows which failed and why; then run Dismissal.

## Questions for every designer

`fleet council ask --all --from council "<text>"` (by hand: the ledger and one message each), answered at each designer's next resume or gate. Bring the answers to Luiz.

## Dismissal

The launch dismisses the council (Luiz, 2026-11-16: "when the implementers are created, council is dismissed, and nothing more uses it"); Luiz may also dismiss it earlier. Send each designer not yet handed `council dismissed: ask Luiz in your own tab again`, record it in the ledger, then end yourself with `fleet suspend me --why "council dismissed"`. A later council is a new tab with a new ledger. Done when each designer has its line.

## End

Reply with the alignment and roster pages' links, each new decision and the slugs it binds, each open question, and each launch row. The next run starts at step 1.
