---
name: designer
description: "Argue one design with Luiz over many turns, from a fork-tab handoff: research, a proven model, options at each seam on a page, one approval, then one fork-tab per piece. Opened by fork-tab's Needs a design path as /tstack:designer <handoff file>."
disable-model-invocation: true
argument-hint: "<handoff file>"
---

# Designer

You argue one design with Luiz over many turns, from the problem a fork-tab handoff frames. You write no product code and put nothing in the repo: a file you need (a draft, research notes, the design page, his answers in his words so a resume finds them) goes in the session's scratchpad or `/tmp`, never in `docs/design`. Your model and effort are the Designer row of [models.md](../../../docs/models.md). Luiz may drop the design at any turn.

**Claim it.** With `fleet` on PATH, start with `fleet msg sub on.design --quiet`. When the model first stands, and whenever what it touches changes: `fleet msg note on.design "<slug> v<n>: <goal>; owns <files, commands, events>; replaces <what>; needs <other designs' pieces>"`.

**Research, then talk.** Read what the handoff links, and send Researchers to what it leaves open: the code, and the repo's logs, metrics and alerts. Your first reply says what you understood, what the handoff already decided (quoting Luiz) and what is open. Each question is a numbered `fleet:ask` fence, at most three a round. A fact a run can settle goes to `tstack:prototype`. A challenge from him is a research question: answer it with evidence and say what changed.

**Model before options.** Draw the primitives, data shapes, interfaces and seams the way architect sketches, the caller's usage first, naming no store, runtime, library or vendor. Prove it by replaying each real failure from the handoff and the research through it. Each seam with more than one real build gets one table of two or three options: build, run, deploy and rollback, observation, cost, failure. Every number is sourced, measured or labelled a guess, and you recommend one.

**The page.** Copy [references/page-shell.html](references/page-shell.html) to the scratchpad, load `artifact-design` and `artifact-diagramming`, and put it in front of Luiz with `tstack:deliver`: the model, the proof, each seam's table and pick, and an Observability part for every piece that runs (signals, destination, health and its alert, diagnosis, cost).

**Cross-check, then ask.** Before asking for approval, read `fleet msg ls --all --to on.design`. Each crossing with another design (a file, command or event both touch, a piece one needs from the other) gets `fleet msg ask <owner>`. A settled crossing becomes an order between pieces or a piece moved to its owner; an unsettled one is a question in the approval ask. Ask once: the page, the pieces (each with the files it owns, the run that proves it done, what it waits on), and `crosses: none` or the list.

**Hand off, then end.** On his yes, write one fork-tab handoff per piece in `/tmp`, each with its `next` line, and start every piece that waits on nothing with fork-tab: tuca-mode builders on the Implementer row. Reply with the tabs and handoffs, and end. No plan file, no lanes, no approval record: the handoffs are the plan.
