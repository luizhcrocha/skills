# The TypeScript fleet is the only fleet; the oracle replays against it

Status: accepted, 2026-10-09 (Luiz). Steps 1 and 2 of retiring the Python fleet twin.

## Context

The fleet has two implementations. The Python twin is `skills/productivity/coordinator/scripts/*.py`: state, chat, fleets, news, usage, spend, served, the dashboard's render and serve. The TypeScript fleet is `fleet/`, run as `fleet/bin/fleet`. Stage 2 ported the Python scripts to TypeScript and proved the port with the oracle (`fleet/oracle`): golden traces recorded from Python, replayed against TypeScript by `just test-fleet-ts-oracle`, plus the model-based test driving either one.

Every command the skills name now runs through `fleet/bin/fleet`. Two things still treated Python as the reference:

- The status line ran `usage.py capture` to keep the plan's usage.
- `run.py record` wrote each trace's `.expected.jsonl` from the Python scripts, so a behaviour change had to land in Python first and be ported after.

Bun is already required. `fleet/package.json` declares `engines.bun >=1.4.2`, and the hub, the page server and the CLI all run on it. Keeping Python as the reference therefore buys no portability; it only doubles every change.

## Decision

- **The TypeScript fleet is the only fleet.** New behaviour, and the fixes it needs, go into `fleet/` only.
- **The Python twin is frozen.** It gets no new features, and bug fixes only, until it is deleted. A behaviour TypeScript changes on purpose is not ported back.
- **Traces are recorded from TypeScript.** `run.py record` replays a trace on `fleet/bin/fleet`, and `just test-fleet-ts-oracle` replays the corpus and the model test against it. Review the diff of a re-recorded `.expected.jsonl` like code.
- **The status line moves first** (step 1, in the dotfiles). It runs `fleet usage capture -- <the status line>`, which reads the same input and writes the same `usage/reading.json` as `usage.py capture`. A sample of five inputs left byte-identical files.
- **Deletion follows in two later steps.** Step 3 deletes the Python fleet's tests: `just test-fleet`, `just test-coordinator`'s Python half, and their `scripts/gates` entries. Step 4 deletes the scripts.

## Consequences

- **Until step 3, `just test-fleet` checks the frozen Python against traces recorded from TypeScript.** It passes as long as both behave alike. When a deliberate TypeScript change diverges from Python, that divergence is the signal to run step 3, not to port the change back.
- **The model test reads its role table from `state.py`** (`test_model.py` imports `ROLES`). A role-table change (ADR 0002, "Evolving it") still edits `state.py` until step 3 moves that read to the TypeScript table. That edit is data, not a feature.

- **The Python hub has no file route and no HTTP probe.** `GET /f/<fleet>/files/<path>` and the links' HTTP probe (with its unknown state and the tailnet-suffix check) exist in the TypeScript hub only. The Python dashboard server shows a link up or down by a TCP probe and serves no linked file. That gap is accepted: nobody runs the Python hub, and step 4 deletes it.
- **A revoked approval cannot be re-granted by the same answer.** `approval add` skips a fleet whose ledger holds an approval from that ref, active or revoked, so the answer that backed a revoked approval never backs a new one. To give it again, ask the user again: the new answer is a new decision, or a new question of the grilling.
- **`from: user` lines are trusted.** A standing approval rests on the user's own message in the fleet's chat, and the hub is the only writer of `from: user` lines: it writes them for what the user sends on the page. An agent that forges such a line by writing `chat.jsonl` directly is outside this model; the fleet's agents write the chat only through `fleet chat`, which never writes as the user.

## Considered and rejected

- **Delete Python in one step:** the status line and the recorder still depended on it. Moving them first lets each deletion be checked by the gate on its own.
- **Keep recording from Python and port each change to both:** it doubles every fleet change for a runtime nobody runs.
