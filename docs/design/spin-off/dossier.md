# spin-off

phase: handed
versions: design v5, plan v3, team v3
spin-off: none (the work was designed in the session that found it, before the skill existed)

The design for the `spin-off` and `designer` skills, recorded in the shape the designer skill's DOSSIER.md gives. Session 7fcb85bb (2026-11-14) ran it by hand, so this record was written after the gates, from that session's transcript.

## Approvals

The plan and the team had no `plan.md` or `team.md`. Each was the text of its gate question, quoted under the table.

| gate | version | parent | file | sha256 | date | Luiz's words | status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| design | v2 | none | page version 2 | not kept | 2026-11-14 | "Approved" | void: the advisor's changes made design v3 |
| plan | v1 | design v2 | gate question | not kept | 2026-11-14 | "Approved" | void: design v3 |
| team | v1 | plan v1 | gate question | not kept | 2026-11-14 | "Approved" | void: design v3 |
| design | v3 | none | design.html | not kept | 2026-11-14 | "Approved" | void: design.html became v4 |
| plan | v2 | design v3 | gate question, quoted below | not kept | 2026-11-14 | "Approved" | void: design v4 |
| team | v2 | plan v2 | gate question, quoted below | not kept | 2026-11-14 | "Approved" | void: design v4 |
| design | v5 | none | the folder (DOSSIER.md hash) | `06e9be7efa2241743f8211bf523e05e51e73e536037d0662e82ef15745ad4528` | 2026-11-14 | "Approved" | live |
| plan | v3 | design v5 | gate question, quoted below | not a file | 2026-11-14 | "Approved" | live |
| team | v3 | plan v3 | gate question, quoted below | not a file | 2026-11-14 | "Approved" | live |

Luiz approved page version 3 at gate 1; its hash was not kept. Page version 4 added only his answers to B, C and D, and the review round changed the model, so both voided v3 and the approvals on it. Design v5 is page version 5 plus the review round's model: a team change goes back through the fleet check, gate 3 can create a project, the `--trust` line goes to Luiz, and the hash covers the folder. Luiz approved v5, plan v3 and team v3 in session 7fcb85bb on 2026-11-14; those three rows are live.

The Implementer started on the v3 approvals, before the rule existed. The land waited for the v5 approvals.

Plan v2, as asked (plan v3 is the same lane; its question added only the quick review before the land): "One lane: the Implementer writes spin-off/SKILL.md; designer/{SKILL.md, DOSSIER.md, LAUNCH.md, references/lifecycle.tla + view.ts}; the Designer row and its context line in docs/models.md; the boundary line in figure-it-out; the pointer in tuca-mode; and the README.md, plugin.json and engineering README entries. Then a Reviewer, a claude -p run, and land."

Team v2, as asked (team v3 is unchanged): "No fleet, since there is one lane and fleet is down. This session coordinates. Implementer: Opus high in ../skills-spin-off. Reviewer: Opus high. Verifier: Opus medium. The runner session runs just validate, just test-changed and the push of master."

## Artifacts

- [design.html](design.html): the design page, published as an Artifact (claude.ai/artifact/99yDshGXVFHM5uV7xAWzG6, page version 5).
- [lifecycle.tla](lifecycle.tla), [lifecycle.cfg](lifecycle.cfg), [view.ts](view.ts): the checked model of the gates. [report.md](report.md) and [chart.mmd](chart.mmd) are its statechart run: 328 states, 1,180 steps, 16 arrows, every rule holds. The skill carries the same model in `skills/engineering/designer/references/`.
- No ADR and no `CONTEXT.md` term: the design binds no fleet.

## Decider

- 2026-11-14. Question: does the v2 design (two skills, the gates, the model, launch through fleet) hold, and what must change before code? Evidence: page v2, the model, the fleet plugin's manager and coordinator skills, tuca-mode, handoff, models.md. Ruling: "go with changes". Approvals belong in the record, not in the session's memory. The designer gets its own jj workspace. The tab opens with `rex run`, not `fleet team add`. The designer runs one `fleet team add` per coordinator itself. The fleet check comes before gate 3. Fable serves as a Decider, not as the fleet advisor. brief.md is renamed spin-off.md. Changed: design v3, which voided the v2 approvals above.

## Launch

| coordinator | repo | status | note |
| :-- | :-- | :-- | :-- |
| none: session 7fcb85bb coordinates | luizhcrocha/skills | started | One Implementer in `../skills-spin-off`, as team v2 says. No orchestrate tab: Luiz approved this session at gate 3. |

## After the land

- 2026-11-14, Luiz in session 7fcb85bb: "the new designer agent should be created on a new rex session, named after the work to be done. when he creates the agent's to impelemnt, he will create in the session he is in." The designer now opens with `rex new <slug>`, and the no-fleet orchestrate tab opens in its session. Coordinators still open in the repo's team session: `fleet team` keeps one Rex session per repo, with one `marks.json` and one `team.lock` per repo (fleet `apps/cli/src/team/team.ts`). Luiz chose to add a session option to fleet; that change is fleet's own work, proposed as a spin-off.
