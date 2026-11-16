---
name: council
description: "Align the designer sessions without waking them all: check their Interfaces cards with fleet council, judge overlaps and conflicts through a Decider, record Luiz's decisions, message only the designers they bind, and launch a split once its designers have planned."
disable-model-invocation: true
---

# Council

You run the council, a tab in the Rex session `designers` beside the designers it aligns. Each designer records what its design owns, reads, emits and needs in an Interfaces card (the [designer](../designer/SKILL.md) skill's DOSSIER.md). You find where those cards meet, bring the conflicts to Luiz, and record his decisions. You route and record. A Decider judges, and Luiz decides. When a split's designers have all stopped at `planned`, you also run its team gate and start its implementers.

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

Run `fleet council check --since-last`. When it reports that no card changed since the last check, tell Luiz that nothing changed and go to step 6. Done when you have the check's output, or have moved to step 6.

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

## 6. Launch a split

A split is several designs of one effort, each registered with `--split <name>` (the [spin-off](../spin-off/SKILL.md) skill). Its designers stop at `planned`, and you start the implementers for all of them at once. Run these steps for each split `fleet council list` shows whose designs are not all `handed`. A split whose `launch.md` already has Launch rows resumes at step 6 and starts only the coordinators without a `started` row.

1. **Ready.** For each slug `fleet council list --split <name>` shows, read the `phase:` line of its dossier, and run `fleet council decisions --for <slug> --unacked`. The split is ready when every phase is `planned` and no decision is unacknowledged. Otherwise tell Luiz which designers the split waits on, and go to the next split. Done when the split is ready, or Luiz knows what it waits on.
2. **Overlap.** Run `fleet council check <slug>` for each design of the split. Then read every design's `plan.md` together: no file sits under two lanes of the split, the partition rule in `tstack:orchestrate`. Bring each finding through steps 4 and 5. A decision that changes a design sends it back through its gates, so the split waits at step 1 again. Done when there are no findings, or each one is decided and the split is ready again.
3. **Record.** Open your own jj workspace in the repo of the first design `fleet council list --split <name>` shows, as the designer's Start step 2 does, named `split-<name>`. The split record is `docs/design/<name>/` there. It lands beside the designs, so coordinators and resumes read it from the repo. Write `team.md` as designer [LAUNCH.md](../designer/LAUNCH.md) shapes it, with the coordinators of every design and each one's design slug. Write `launch.md` with an Approvals table and a Launch table in [DOSSIER.md](../designer/DOSSIER.md)'s shapes, the Launch table with a `design` column first. Done when both files exist.
4. **Fleet check.** Follow LAUNCH.md's Fleet check for every design, against the split's `team.md`. When `fleet ls` fails, tell Luiz in one line that the fleet is down and stop. A clash that changes a plan goes to its designer as `fleet council ask --to <slug> --from council "<the clash>"`, and the split waits at step 1. Done when every check passes on the current team version.
5. **Team gate.** Show Luiz the split's plans together on one page through `tstack:show-me` (an Artifact): each design's lanes, its coordinators, and the overlap result. Then ask one gate for the whole split with `AskUserQuestion`: the team version, `team.md`'s path, the page's link, and approve or change. The designer's rules in "The gates" apply: only a yes Luiz types here counts, and you record it in `launch.md`'s Approvals the moment it arrives, with his words and `team.md`'s sha256. A change makes a new team version, which goes through step 4 again. Done when `launch.md` records Luiz's live approval of the current team version.
6. **Launch.** Follow LAUNCH.md's Launch steps 1 and 3 to 6 for every design, with these changes:
   - Step 1 rechecks each dossier's design and plan approvals, and `launch.md` for the team approval.
   - Step 2 is done: each designer landed its folder at `planned`.
   - Step 4 passes `--session <name>`, so every implementer opens in the Rex session named after the split, and writes each row to `launch.md`.
   - Step 5 posts once for the split, `--from council`, naming the record's path.
   - Step 6 sets no phase. Each designer records `handed` after step 7 below.

   Done when `launch.md` has a row for every coordinator, and Luiz has each failure with its reason.
7. **Hand back**, once every row in `launch.md` says `started`. Until then, retry the failed coordinators as LAUNCH.md's Launch step 4 says, on Luiz's word. Land `docs/design/<name>/` through tuca-mode's Land playbook. Then run `fleet council ask --to <slug>,<slug> --from council "split <name> launched, record at <repo>/docs/design/<name>/launch.md. Record handed as designer SKILL.md's Split says, then answer."` with every slug of the split. Then forget your workspace: `jj workspace forget split-<name>`. Done when `<bookmark>@origin` holds the record and every designer has the question.

## Staffing designers at gate 3

Luiz may call a council on a few related designers waiting at gate 3, to staff them together instead of each one alone. Done for the run when each named designer has its part or Luiz kept their own teams.

1. Read each named designer's `plan.md` and `team.md`. Done when both are read for each.
2. Spawn one Decider (`model: "fable", effort: "high"`) with those files. It returns one staffing for all of them: the implementer agents, the lanes each takes across the designs, what each waits on, and which designer starts it, with no file under two agents. Done when every lane is in exactly one agent.
3. Ask Luiz with `AskUserQuestion`: take the staffing, change it, or keep each designer's own team. Done when he has chosen.
4. Record his choice with `fleet council decide --binds <slug>,<slug> --words "<Luiz's words>" "<the staffing, one line>"` and write each designer's part in the decision's text or a file it names. Send each bound designer one SendMessage line: `council C-<n>: your part of the staffing is in fleet council show C-<n>`. Done when each designer has its line.

## Questions for every designer

When Luiz wants an answer from every designer, run `fleet council ask --all --from council "<text>"` and send no message. Each designer answers at its next resume or gate. On a later run, `fleet council questions` shows who has answered. Bring the answers to Luiz. Done when he has the `Q-<n>`, and later the answers.

## End

Reply with the page's link, each new decision with the slugs it binds, each new question, each drafted card's path, and each split launched or waiting. Then stop. The next run starts at step 1.
