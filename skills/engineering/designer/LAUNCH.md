# Plan, team and launch

Read from the designer's [SKILL.md](SKILL.md) when you write the plan, check the fleet, write the team, or launch. Record every gate and launch step in the dossier ([DOSSIER.md](DOSSIER.md)).

## plan.md (gate 2)

`docs/design/<slug>/plan.md` lists the lanes in dependency order: a lane comes after the lanes it depends on. Landing order is the manager's, so the plan gives none. Per lane:

- **id** and **goal**, one sentence.
- **files owned**: paths or globs. No two lanes own one file (the partition rule in `tstack:orchestrate`).
- **depends-on**: lane ids, or none.
- **suggested role**: from [models.md](../../../docs/models.md), marked advisory, since the coordinator decides.
- **done criterion**: a check someone can run or read.

Done when every lane has all five and no file appears under two lanes.

## Fleet check (before gate 3)

`command -v fleet` finds nothing: take [No fleet](#no-fleet). Otherwise run `fleet ls`. When it fails, set the phase to `parked`, tell Luiz in one line that the fleet is down, and end the turn; on his next message run it again. When it answers, check:

- **Names.** Each coordinator's name is lower-case letters, digits and `-`, starts with a letter, has at most 32 characters, and is absent from `fleet ls`: a name is one per machine.
- **Missions.** Each is one line of plain ASCII text, at most 2,000 characters (`fleet team add --help`), with no `|`, `*`, `\` or `$`. It points at `docs/design/<slug>/plan.md` and names its lanes instead of restating them.
- **Files.** No lane's files overlap the lanes of a fleet already running in the same repo (`lanes:` in `fleet ls`, then that fleet's ledger).
- **Project.** A new project's id in `team.md` is absent from `fleet project list`.

Done when every check passes. A clash changes the team or the plan: a plan change voids its approval, so gate 2 comes back first. A team change, for a clash or at Luiz's word at gate 3, makes a new team version, and that version goes through this check again before gate 3.

## team.md (gate 3)

`docs/design/<slug>/team.md`:

- **project**: an existing fleet project's id (`fleet project list`), since `fleet team add` needs one. When none fits, write `project: new <id> "<title>"` instead, and gate 3 offers three answers: approve the team and create that project, change the team, or drop the spin-off. On the yes Luiz types, run `fleet project new "<title>" --id <id>` once, in Launch, after step 3 and before step 4. The `--id` gives the project the id `team.md` already names, so the file and its approval stay as they are. When the command fails, the team changes and gate 3 comes back.
- **manager**: the project's existing manager. A project has at most one, so the designer adds none.
- **coordinators**: per coordinator, its name, its repo, the lanes it owns and its mission line.

Ask gate 3 only after the fleet check passed on the current plan and the current team version.

## Launch

1. Recheck the record (DOSSIER.md, "Resume from the record"). Launch only when all three approvals are live; otherwise go to the gate the record names.
2. Land `docs/design/<slug>/`, with any ADRs and `CONTEXT.md` edits, as docs through tuca-mode's Land playbook. The coordinators' workspaces see the design only once it has landed. Done when `<bookmark>@origin` holds the folder.
3. Run `fleet ls` again. When it fails, the phase goes back to `parked`.
4. Per coordinator, as one Bash call with `timeout: 300000`, in that coordinator's repo: `cd <repo>; fleet team add <name> --project <id> --mission "<mission>" --session <slug>`. `--session` opens the coordinator in your Rex session, beside you, not in the repo's team session. Write the coordinator's row in the dossier's **Launch** table as the call returns, then go on to the next. When the call does not start it:
   - **Untrusted repo.** The refusal names `--trust`. Ask Luiz with `AskUserQuestion`, showing the exact line you would run: `cd <repo>; fleet team add <name> --project <id> --mission "<mission>" --session <slug> --trust`. On the yes he types, run that line once, unchanged.
   - **Auto mode refuses** a call, this one or the `--trust` line. Report the refusal and the refused line to Luiz, record the row as `refused`, and do nothing else for that coordinator: no retry, no other route.
   - **Killed midway.** The tool killed the run. Run the same `add` again: it starts the file it wrote.
   - **No tab.** `add` removed its file. Fix what the refusal names, then run `add` again.
   - **A startup prompt.** Luiz answers it in the Rex app (`fleet team attach <name>`), then run `fleet team start <name>`.
5. Post the news, which wakes nobody: `fleet news post --from designer-<slug> --to all --kind fyi "spin-off <slug> launched: <coordinators>; design in docs/design/<slug>/"`.
6. Set the phase to `handed` when every row says `started`. Otherwise tell Luiz which coordinators failed and why.
7. Land the dossier with its **Launch** rows and phase as a follow-up docs change, as in step 2: the copy landed in step 2 predates the launch. Then forget the design workspace: `jj workspace forget design-<slug>`.

## No fleet

On a machine without `fleet` (decision D, 2026-11-14), the plan runs in one new tuca-mode tab under `tstack:orchestrate`, in your own Rex session. `team.md` names that session in place of coordinators: its label, its repo, and the Coordinator pair from models.md. Gate 3 approves that session. Then run Launch steps 1 and 2 (recheck the record, land the docs) and open the tab. Inside Rex:

```sh
rex run -s "$REX_SESSION" -c <repo> --label <label> -- claude --name <label> --model opus --effort medium "/tstack:tuca-mode /tstack:orchestrate docs/design/<slug>/plan.md"
```

Outside Rex, give Luiz the same launch in nushell: `cd <repo>; claude --name <label> --model opus --effort medium "/tstack:tuca-mode /tstack:orchestrate docs/design/<slug>/plan.md"`. Record the session as the one row of **Launch**, set the phase to `handed`, run Launch step 7, and stop.
