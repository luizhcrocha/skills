# Plan, team and launch

Record each step in the dossier ([DOSSIER.md](DOSSIER.md)).

## plan.md

`docs/design/<slug>/plan.md` lists the lanes in dependency order. Landing order is the manager's, so the plan gives none. Per lane:

- **id** and **goal**, one sentence.
- **files owned**: paths or globs. No two lanes own one file (the partition rule in `tstack:orchestrate`).
- **depends-on**: lane ids, or none.
- **suggested role**: from [models.md](../../../docs/models.md), advisory, since the coordinator decides.
- **done criterion**: a check someone can run or read. A lane that builds a running piece owns its signals and alerts from the design's Observability section, and its criterion includes seeing them work.

Done when every lane has all five and no file appears under two lanes.

## Preflight

`command -v fleet` finds nothing: take [No fleet](#no-fleet). `fleet ls` fails: set the phase to `parked`, tell Luiz in one line that the fleet is down, and run it again on his next message. Otherwise check, and fix each miss yourself:

- **Names.** Each coordinator's name meets `fleet team add --help` and is absent from `fleet ls`; otherwise pick another.
- **Missions.** Each meets the limits in `fleet team add --help`, is plain ASCII without `|`, `*`, `\` or `$`, points at `docs/design/<slug>/plan.md` and names its lanes. When another fleet waits on one of its lanes, it names its tells: "on landing a lane, fleet news post --to <fleets> naming the lane and commit".
- **Project.** A new project's id is absent from `fleet project list`; otherwise pick another.
- **Files.** No lane's files overlap the lanes of a fleet already running in the same repo (`lanes:` in `fleet ls`, then that fleet's ledger). An overlap is the one miss you take to Luiz: the overlapping paths, and the choice to wait for that fleet, re-partition, or drop.

Done when every check passes.

## team.md

`docs/design/<slug>/team.md`:

- **project**: an existing fleet project's id (`fleet project list`), or `project: new <id> "<title>"` when none fits.
- **manager**: the project's existing manager; the designer adds none.
- **coordinators**: per coordinator, its name, its repo, the lanes it owns and its mission line.

## Launch

1. **Record.** The dossier holds a `design` and a `team` row, and every edit since either approval is in Edits after approval with each material one approved. Under a council, when `fleet council --help` succeeds, apply every decision `fleet council decisions --for <slug> --unacked` lists ([COUNCIL.md](COUNCIL.md)) first.
2. **Land** `docs/design/<slug>/` through tuca-mode's Land playbook; land-check decides, with no ask from you. Done when `<bookmark>@origin` holds `team.md`.
3. **Preflight** again. A fix that is material goes to Luiz as DOSSIER.md says.
4. **Project.** When `team.md` says `new`, run `fleet project new "<title>" --id <id>` once. On failure, tell Luiz the error.
5. **Start** each coordinator, one Bash call each with `timeout: 300000`, in its repo: `cd <repo>; fleet team add <name> --project <id> --mission "<mission>" --session <session>`, where `<session>` is `<slug>`, or the session a council names; never `designers` or the repo's team session. Write its **Launch** row as the call returns. When it does not start:
   - **Untrusted repo** (the refusal names `--trust`): ask Luiz with the exact line plus `--trust`; on his yes run it once, unchanged.
   - **Refused** by auto mode or by `session <session> is the team of <repo>`: record `refused` and tell Luiz, or the council; no retry, no other route.
   - **Opening not sent**: `rex capture` its tab; when the whole opening sits in the input box, `rex send-key -b <block> enter` and record `started`.
   - **Killed midway, or no tab**: fix what the refusal names and run `add` again.
   - **A startup prompt**: Luiz answers it in the Rex app (`fleet team attach <name>`), then `fleet team start <name>`.
6. **Verify.** `fleet ls` shows exactly `team.md`'s coordinators for this work. Stop any other the launch started (`cd <repo>; fleet team stop <name>`) and say so in the reply.
7. **News**, which wakes nobody: `fleet news post --from <slug>-designer --to all --kind fyi "spin-off <slug> launched: <coordinators>; design in docs/design/<slug>/"`.
8. **Hand over.** Set the phase to `handed` when every row says `started`; otherwise tell Luiz which failed and why. Land the dossier as a follow-up docs change. When `fleet council --help` succeeds, re-register it: `fleet council register <slug> --dossier <repo>/docs/design/<slug>/dossier.md --repo <repo>`.

## No fleet

On a machine without `fleet` (decision D, 2026-11-14), the plan runs in one new tuca-mode tab under `tstack:orchestrate`, in a new Rex session `<slug>`. `team.md` names that tab in place of coordinators: its label, its repo, and the Coordinator row of models.md; Approval B approves it. Then run Launch steps 1 and 2, and open the tab as [spin-off](../spin-off/SKILL.md) step 4 opens one: label `<label>`, Rex session `<slug>`, folder `<repo>`, the Coordinator row, opening `/tstack:tuca-mode /tstack:orchestrate docs/design/<slug>/plan.md`. Record it as the one **Launch** row, set the phase to `handed`, land the dossier, and stop.
