Skills are organized into bucket folders under `skills/`:

- `engineering/` — daily code work
- `productivity/` — daily non-code workflow tools
- `misc/` — kept around but rarely used
- `personal/` — tied to my own setup, not promoted
- `in-progress/` — drafts not yet ready to ship
- `deprecated/` — no longer used

Every skill in `engineering/`, `productivity/`, or `misc/` must have a reference in the top-level `README.md` and an entry in `.claude-plugin/plugin.json`. Skills in `personal/`, `in-progress/`, and `deprecated/` must not appear in either.

Each skill entry in the top-level `README.md` must link the skill name to its `SKILL.md`.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`.

## The fleet

The TypeScript fleet (`fleet/`, run as `fleet/bin/fleet`) is the only fleet. The Python scripts in `skills/productivity/coordinator/scripts/` are a frozen twin: bug fixes only, no new features, until they are deleted (ADR 0003, docs/adr/0003-typescript-fleet-is-the-only-fleet.md).

## Testing

- `just test-changed [REVSET]` runs only the suites whose inputs changed in REVSET (default `master@origin..@`, the stack) and prints which it chose and why. The table is `SCOPE` in `scripts/gates`; a path it doesn't name runs everything. A worker runs this before it reports.
- `just test` runs every suite in parallel, each one's output grouped under its PASS/FAIL line and duration. The lead runs it once per landing, on the stack's head, not after each worker.
- One suite alone: `just test-fleet-ts`, `just test-page`, and the rest in `just --list`.
- A page change (fleet/page, rebuilt into `assets/dashboard.html` by `just build-page`) re-records no oracle trace: the traces keep the state a rendered `index.html` carries, not its bytes. Re-record a trace only when the fleet's behaviour changes on purpose (fleet/SPEC.md, "Oracle traces").
