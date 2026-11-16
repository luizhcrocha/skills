# Plan, team and launch

Read from the designer's [SKILL.md](SKILL.md) when you write the plan, check the fleet, write the team, or launch. Record every gate and launch step in the dossier ([DOSSIER.md](DOSSIER.md)).

## plan.md (gate 2)

`docs/design/<slug>/plan.md` lists the lanes in dependency order: a lane comes after the lanes it depends on. Landing order is the manager's, so the plan gives none. Per lane:

- **id** and **goal**, one sentence.
- **files owned**: paths or globs. No two lanes own one file (the partition rule in `tstack:orchestrate`).
- **depends-on**: lane ids, or none.
- **suggested role**: from [models.md](../../../docs/models.md), marked advisory, since the coordinator decides.
- **done criterion**: a check someone can run or read. A lane that builds a running piece owns that piece's signals and alerts from the design's Observability section, and its criterion includes seeing them work: the log line or metric on its dashboard, a test alert reaching its receiver.

Done when every lane has all five and no file appears under two lanes.

## Fleet check (before gate 3)

`command -v fleet` finds nothing: take [No fleet](#no-fleet). Otherwise run `fleet ls`. When it fails, set the phase to `parked`, tell Luiz in one line that the fleet is down, and end the turn; on his next message run it again. When it answers, check:

- **Names.** Each coordinator's name meets `fleet team add --help` and is absent from `fleet ls`.
- **Missions.** Each meets the limits in `fleet team add --help`, is plain ASCII, and has no `|`, `*`, `\` or `$`. It points at `docs/design/<slug>/plan.md` and names its lanes instead of restating them.
- **Files.** No lane's files overlap the lanes of a fleet already running in the same repo (`lanes:` in `fleet ls`, then that fleet's ledger).
- **Project.** A new project's id in `team.md` is absent from `fleet project list`.

Done when every check passes. A clash changes the team or the plan, which voids as DOSSIER.md's Voiding says. A new team version, for a clash or at Luiz's word at gate 3, goes through this check again before gate 3.

## team.md (gate 3)

`docs/design/<slug>/team.md`:

- **project**: an existing fleet project's id (`fleet project list`), since `fleet team add` needs one. When none fits, write `project: new <id> "<title>"` instead, and gate 3 offers three answers: approve the team and create that project, change the team, or drop the spin-off. On the yes Luiz types, run `fleet project new "<title>" --id <id>` once, in Launch, after step 3 and before step 4. The `--id` gives the project the id `team.md` already names, so the file and its approval stay as they are. When the command fails, the team changes and gate 3 comes back.
- **manager**: the project's existing manager. A project has at most one, so the designer adds none.
- **coordinators**: per coordinator, its name, its repo, the lanes it owns and its mission line.

Ask gate 3 only after the fleet check passed on the current plan and the current team version.

When another tab whose name holds `-designer` is open in the Rex session `designers` (`rex window ls -s designers`), gate 3 also offers **Hold for the council**: related designers may be staffed together (COUNCIL.md, Staffing). On that answer, set the phase to `parked` with the reason `council`, rename your tab to `<slug>-designer (council)` so the tab bar shows the wait (`rex window rename -s designers <window> "<slug>-designer (council)"`; the session keeps its name, which is its address). From there SKILL.md's "Under a council" holds: the council asks your gates and launches your coordinators. When Luiz releases the hold without a council, rename the tab back to `<slug>-designer` and go on here. The hold is Luiz's: a missing `fleet council` never releases it. On 2026-11-16 run-efficiency launched while its neighbours were held, because `fleet council --help` failed on that machine, and Luiz had its workers stopped.

## Launch

1. Recheck the record (DOSSIER.md, "Resume from the record"). Launch only when all three approvals are live; otherwise go to the gate the record names. When `fleet council --help` succeeds, also refuse while `fleet council decisions --for <slug> --unacked` lists anything: run the Inbox ([COUNCIL.md](COUNCIL.md)) first, then recheck.
2. Land `docs/design/<slug>/`, with any ADRs and `CONTEXT.md` edits, as docs through tuca-mode's Land playbook. The coordinators' workspaces see the design only once it has landed. Done when `<bookmark>@origin` holds the folder.
3. Run `fleet ls` again. When it fails, the phase goes back to `parked`.
4. Per coordinator, as one Bash call with `timeout: 300000`, over the join and start waits `fleet team add --help` gives, in that coordinator's repo: `cd <repo>; fleet team add <name> --project <id> --mission "<mission>" --session <slug>`. `--session` opens the Rex session `<slug>` as `fleet team add --help` says. Coordinators never open in `designers` or in the repo's team session. Write the coordinator's row in the dossier's **Launch** table as the call returns, then go on to the next. When the call does not start it:
   - **Untrusted repo.** The refusal names `--trust`. Ask Luiz with `AskUserQuestion`, showing the exact line you would run: `cd <repo>; fleet team add <name> --project <id> --mission "<mission>" --session <slug> --trust`. On the yes he types, run that line once, unchanged.
   - **Auto mode refuses** a call, this one or the `--trust` line. Report the refusal and the refused line to Luiz, record the row as `refused`, and do nothing else for that coordinator: no retry, no other route.
   - **The session belongs to another repo.** The refusal says `session <slug> is the team of <repo>`: `fleet team` binds a session to the first repo that adds to it. Stop that coordinator, record the row as `refused`, and tell Luiz. The coordinators stay in the one session `<slug>` he asked for, never in a second session named for the repo.
   - **Opening not sent.** The call says `its opening was not sent`: a long opening wraps and outlasts the 30 s check. `rex capture` the coordinator's tab; when the whole opening sits in its input box, press Enter with `rex send-key -b <block> enter`, then record the row as `started`.
   - **Killed midway, or no tab.** Fix what the refusal names and run `add` again (`fleet team add --help` says what each case left behind).
   - **A startup prompt.** Luiz answers it in the Rex app (`fleet team attach <name>`), then run `fleet team start <name>`.
5. Post the news, which wakes nobody: `fleet news post --from <slug>-designer --to all --kind fyi "spin-off <slug> launched: <coordinators>; design in docs/design/<slug>/"`.
6. Set the phase to `handed` when every row says `started`. Otherwise tell Luiz which coordinators failed and why.
7. Land the dossier with its **Launch** rows and phase as a follow-up docs change, as in step 2: the copy landed in step 2 predates the launch. When `fleet council --help` succeeds, re-register the landed dossier: `fleet council register <slug> --dossier <repo>/docs/design/<slug>/dossier.md --repo <repo>`, with `<repo>` the repo's root. Then forget the design workspace: `jj workspace forget design-<slug>`.

## No fleet

On a machine without `fleet` (decision D, 2026-11-14), the plan runs in one new tuca-mode tab under `tstack:orchestrate`, in a new Rex session `<slug>`, named after the work. `team.md` names that tab in place of coordinators: its label, its repo, and the Coordinator row of models.md. Gate 3 approves that tab. Then run Launch steps 1 and 2 (recheck the record, land the docs) and open the tab as [spin-off](../spin-off/SKILL.md) step 4 opens one: label `<label>`, Rex session `<slug>`, folder `<repo>`, the Coordinator row, opening `/tstack:tuca-mode /tstack:orchestrate docs/design/<slug>/plan.md`. Record the tab as the one row of **Launch**, set the phase to `handed`, run Launch step 7, and stop.
