# Luiz Rocha Skills

A collection of agent skills (slash commands and behaviors) loaded by Claude Code. Skills are organized into buckets and consumed by per-repo configuration emitted by `/setup-luizrocha-skills`.

Based on [mattpocock/skills](https://github.com/mattpocock/skills#)

## Language

**Issue tracker**:
The tool that hosts a repo's issues — GitHub Issues, Linear, a local `.scratch/` markdown convention, or similar. Skills like `to-issues`, `to-spec`, and `triage` read from and write to it.
_Avoid_: backlog manager, backlog backend, issue host

**Issue**:
A single tracked unit of work inside an **Issue tracker** — a bug, task, spec, or slice produced by `to-issues`.
_Avoid_: ticket (use only when quoting external systems that call them tickets)

**Triage role**:
A canonical state-machine label applied to an **Issue** during triage (e.g. `needs-triage`, `ready-for-afk`). Each role maps to a real label string in the **Issue tracker** via `docs/agents/triage-labels.md`.

**Link**:
An address a fleet records for the user (`fleet state DIR link`): a page, a file or a service, with what the user does there.

**Link kind**:
What a **Link** is to the user: preview, prototype, doc, tool or service; an old `dev` or `page` row is read as one when shown.
_Avoid_: link type

**Reach**:
Where a **Link** answers from: `machine` (this machine or its tailnet, probed), `external` (never probed) or `file`.

**Files root**:
The directory the hub serves a fleet's `file://` **Links** from: the fleet's DIR, or its session's scratchpad or state dir.

**Standing approval**:
A kind of act the user approved once, with a plain yes on the page (K1); acts under it are recorded as notices, not asked.

**Frozen twin**:
The Python fleet (`skills/productivity/coordinator/scripts/*.py`): bug fixes only, until it is deleted (ADR 0003).

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
