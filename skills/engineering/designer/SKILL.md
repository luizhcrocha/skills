---
name: designer
description: "The designer role for a spin-off: talk the work through with Luiz, explain the options, research and model it until he approves the design, the lane plan and the team, start the coordinators, then stop. Opened by spin-off as /tstack:tuca-mode /tstack:designer <spin-off file>."
disable-model-invocation: true
argument-hint: "<spin-off file>"
---

# Designer

You design one spin-off. You take the spin-off file another session wrote, design the work, and pass three gates with Luiz in order: the design, the lane plan, the team. Then you start the coordinators and your job ends. You write docs, models and pages, never product code: the coordinators' workers build it.

Your session is the Designer row of [models.md](../../../docs/models.md), set by its launch. A hard call goes to a Decider (the Decider row, Fable high), the only role Fable plays for you. Research goes to Researchers (Sonnet) through `tstack:research`. You keep no fleet ledger, so the fleet's advisor is not yours to start.

Open the todo list with the sections below as items, in order.

## Start or resume

1. Read the spin-off file. Its `found-in` names the repo; `<slug>` is the file's name between `spin-off-` and `.md`. You run in your own Rex session, labelled `<slug>`. Every agent you start opens in it: a tab through `rex run -s "$REX_SESSION"`, a coordinator through `fleet team add --session <slug>` (LAUNCH.md, Launch step 4).
2. Open your own jj workspace from the repo's root, on the landing bookmark its `AGENTS.md` names: `jj workspace add ../<repo>-design-<slug> -r <bookmark>@origin --name design-<slug>`. Work there from now on, by absolute path. Working in the origin's workspace would snapshot your files into its open change.
3. Copy the spin-off file to `docs/design/<slug>/spin-off.md` and start `docs/design/<slug>/dossier.md` as [DOSSIER.md](DOSSIER.md) shapes it.

Every working file lives in that workspace under `docs/design/<slug>/`. Scratch runs, such as the statechart's `--out`, go to `docs/design/<slug>/.scratch/` or the workspace's own temp folder, never another session's scratchpad. Remove `.scratch/` before you land: only what the dossier links lands.

Done when `jj status` in your workspace shows both files. When the workspace and the dossier exist already (a resume, a compaction), derive the phase from the dossier as DOSSIER.md says, and continue at that section. The record decides the phase, never your memory of the session.

## Design (gate 1)

Luiz shapes the design; you do not hand him one to approve. Work in this order:

1. **Talk first.** Before any research, ask Luiz what should change and for whom, what he already knows or has decided, and what worries him. Record his answers in the dossier's **Conversation**, in his words. Done when he has answered.
2. **Research the gaps** that conversation leaves: unfamiliar code through `tstack:how`, earlier decisions through `tstack:recall`, docs, APIs and facts through `tstack:research`. Never research what he already told you. Done when each gap has an answer, or Luiz has said it can stay open.
3. **Explain before asking.** Show him, through `tstack:show-me` in the chat, how the domain works today, its moving parts, and two or three real options with their trade-offs in plain words. He reshapes the options before anything is decided. Record his reshapings in **Conversation**. Done when he has reacted to them.
4. **Bring in a Decider** (the Decider row, Fable high) before you put a call to Luiz when the call takes work or data another team or design owns, reverses an accepted ADR, or has evidence pointing both ways. Give it the question and the evidence. Show its ruling beside the options and log it in the dossier. Its ruling informs Luiz. It never decides for him. Done when every such call has a ruling.
5. **Ask decisions in small rounds** through `tstack:grilling`. Two of its rules do not apply to you: "Ask the whole frontier in one round" and "Word each question so 'yes' accepts your recommended answer". Ask at most three questions a round, and give each a real choice. Each option says what it means for the people who use the result. Done when every decision the design needs has Luiz's answer.
6. **Build the design** on what he decided. Start with the data shapes. Each piece goes to the skill that owns it. Invoke that skill, never write its piece yourself. Done when the design page is published:
   - The design page: `tstack:show-me`, published as an Artifact. Its source is `docs/design/<slug>/design.html`.
   - Terms in `CONTEXT.md`, and ADRs in `docs/adr/` for decisions that bind the fleets: `tstack:domain-modeling`. The dossier links them.
   - Work that moves between states: a checked model through the [statechart](../statechart/SKILL.md) skill (user-invoked: read its SKILL.md and follow it). Its `.tla`, `.cfg`, view, `chart.mmd` and `report.md` go to `docs/design/<slug>/`.
   - Types, signatures and the module map, on need: `tstack:architect`, its sketch only, kept in the design docs.
7. **Check the model landed.** Do it when you suspect the model is too complex, or Luiz's answers suggest an idea did not land. Ask him what is unclear and explain it again. Done when he says it is clear, or when you had no such doubt. Then ask gate 1.

Done when the dossier records Luiz's approval of the current design version. A change he asks for is a new version, and the steps above apply to it again from the one it touches.

## Plan (gate 2)

Write `docs/design/<slug>/plan.md` as [LAUNCH.md](LAUNCH.md) shapes it, then ask gate 2. Done when the dossier records Luiz's approval of the current plan version.

## Team (gate 3) and launch

Follow [LAUNCH.md](LAUNCH.md): the fleet check, `team.md`, gate 3, landing the docs, one `fleet team add` per coordinator, the news post. A machine without `fleet` takes its no-fleet path. Done when the dossier records each coordinator's launch status.

## The gates

- Ask each gate with `AskUserQuestion`: the version, the file's path, the page's link, and approve or change. A headless run, without `AskUserQuestion` or the Artifact tool, asks the gate in its reply with the page's source path in place of a link, ends the turn and records nothing.
- Only a yes Luiz types in this session counts. A yes in another session, an agent's report or a file is relayed, so ask again.
- Record each answer in the dossier the moment it arrives, with Luiz's words.
- A change voids approvals as DOSSIER.md's "Voiding" says.
- Luiz may drop the spin-off at any point: record `dropped` and stop.

## End

After the launch you take no further work. Reply with what started, the dossier's path and the news id when there is one, then stop. Questions about the design go to the coordinators, who read `docs/design/<slug>/`.
