# The dossier

`docs/design/<slug>/dossier.md` is the designer's record and the only source of the phase. Write it the moment each thing happens: an answer from Luiz (**Conversation**), an approval (**Approvals** and the phase), a new design version (**Artifacts** and the **Interfaces** card), a coordinator started (**Launch**).

## Shape

```markdown
# <slug>

phase: designing
design: v1
spin-off: spin-off.md

## Approvals

| gate | date | change | Luiz's words |
| :-- | :-- | :-- | :-- |

## Edits after approval

## Conversation

## Artifacts

## Interfaces

card for design v<n>

| kind | id | path |
| :-- | :-- | :-- |

## Constraints

## Decider

## Launch

| coordinator | repo | status | note |
| :-- | :-- | :-- | :-- |
```

## Phase

`designing`, `review` (Approval A asked), `team` (Preflight and Approval B), `launching`, `handed`, `parked` (fleet down), or `dropped`. On a resume: no `design` row is `designing` or `review`; a `design` row without a `team` row is `team`; both rows are `launching`, which reads **Launch** and starts only the coordinators not yet `started`. `parked`, `handed` and `dropped` stay as written.

## Approvals

One row per yes: **gate** `design` (design and plan) or `team`; the date; **change**, the jj change id holding what he approved; his words, or `C-<n>` for a version a council decision approved. Before recording, run `jj new` in the workspace so the approved change stays as he saw it; the change id is `@-`.

## Edits after approval

Every later edit to an approved file is a line here: the date, the file, what changed, and `material` or not. **Material** is a change to the model, a seam choice, a file moving between coordinators, or a coordinator added or dropped. Ask a material edit once, showing `jj diff --from <change> -- docs/design/<slug>/`; his yes is a new Approvals row. Any other edit launches as it is and is named in the launch reply.

## Artifacts

The design page's link and source, `model.md`, the statechart files and `CONTEXT.md` terms, each by path.

## Interfaces

The card neighbouring designs and `fleet council check` read to find where designs meet. Its first line is `card for design v<n>`. One row per thing the design touches outside itself:

- **kind**: `owns`, `reads`, `emits`, `consumes`, `replaces`, `needs` or `open`.
- **id**: `<type>:<name>`, such as `pg:<schema>.<table>`, `host:<domain>`, `event:<name>`, `zoho:fn/<name>`, `role:<name>` or `repo:<path>`. A trailing `*` matches a prefix.
- **path**: the repo-relative file that defines it.

Done when every table, event, host and role the design touches has a row.

## Constraints

One row per council decision you acknowledged: `C-<n>`, the constraint, and the result, `no change` or `design v<n>`.

## Decider

One entry per question put to a Decider: the date, the question, the evidence, its ruling (or "this is Luiz's") and what changed. A ruling never stands in for an approval.

## Launch

One row per coordinator in `team.md`, written as each `fleet team add` returns: `started`, `failed` with the error, or `refused` with what refused it.
