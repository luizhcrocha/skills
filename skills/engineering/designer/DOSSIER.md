# The dossier

Read from the designer's [SKILL.md](SKILL.md) when you start the dossier, record a gate, change a version, or resume.

`docs/design/<slug>/dossier.md` is the designer's record and the only source of the phase. A compacted or resumed designer reads it and knows where it stands; launch reads its approvals and nothing else. Write each entry the moment its event happens.

The gates follow a checked model: [references/lifecycle.tla](references/lifecycle.tla) with its config and view. TLC holds four rules over it: coordinators start only when the record shows the current design, plan and team each approved; a plan approval sits on the current approved design; a team approval sits on the current approved plan; Luiz sees each team version only after a fleet check passed on it, so a change to the design, the plan or the team sends it back through the check. Rerun it through the statechart skill when you change how the gates work.

## Shape

```markdown
# <slug>

phase: designing
versions: design v0, plan v0, team v0
spin-off: spin-off.md

## Approvals

| gate | version | parent | file | sha256 | date | Luiz's words | status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |

## Artifacts

## Decider

## Launch

| coordinator | repo | status | note |
| :-- | :-- | :-- | :-- |
```

- **phase** is one of `designing`, `designReview`, `planReview`, `fleetCheck`, `parked`, `teamReview`, `ready`, `handed`, `dropped`: the model's names for the chart's states.
- **versions** count each artifact's revisions. A version is 0 until its file first exists, 1 from then, and each new version adds 1. The model counts from the first file, so its version 0 is the record's v1.
- **Artifacts** lists the design page's link and source, the statechart files, the ADRs and `CONTEXT.md` terms, each by path.

## Approvals

One row per answer at a gate:

- **gate**: design, plan or team.
- **version**: the version Luiz saw.
- **parent**: the approved version of the gate before (none for the design).
- **file**: the file the gate approves: `design.html` (its hash covers the folder), `plan.md` or `team.md`.
- **sha256**, taken when Luiz answered. For the plan and the team, `sha256sum` of that file. For the design, one hash over every file in `docs/design/<slug>/` except `dossier.md`, `plan.md`, `team.md` and `.scratch/`: the sha256 of the sorted per-file `sha256sum` lines, from inside the folder:

  ```sh
  find . -type f ! -path './.scratch/*' ! -name dossier.md ! -name plan.md ! -name team.md -print0 | sort -z | xargs -0 sha256sum | sha256sum
  ```
- **date** and **Luiz's words**, as he typed them in this session. Only that counts as a yes.
- **status**: `live`, or `void: <why>`.

## Voiding

An edit to an approved file makes a new version and voids its approval. For the design, an edit to any artifact the page links counts too. A new design version voids the plan's and the team's approvals. A new plan version voids the team's. Keep the voided rows: they show what Luiz saw before. Then ask each voided gate again, in order.

## Resume from the record

An approval is live only when its version is the current one, its sha256 matches the same hash taken now (for the design, the folder's combined hash above), and its parent is the live approved version of the gate before. Recheck all three on every resume and before launch, so a missed voiding still blocks. Then the phase is the first gate without a live approval:

- No live design approval: `designing` until the current version's page is published, then `designReview`.
- No live plan approval: `planReview`.
- No live team approval: `fleetCheck`, so the fleet check runs again before gate 3.
- All three live: `ready`. Check **Launch** for coordinators already started before you run any `fleet team add`.

`parked`, `handed` and `dropped` are kept as written: parked waits on the fleet, and the other two have nothing left to do.

## Decider

One entry per question put to a Decider: the date, the question, the evidence given, its ruling (or "this is Luiz's") and what changed because of it. A ruling never stands in for a gate.

## Launch

One row per coordinator in `team.md`, written as each `fleet team add` returns: `started`, `failed` with the error, or `refused` with what refused it. The launch is not atomic, so the rows are how a resume knows which coordinators still need a start.
