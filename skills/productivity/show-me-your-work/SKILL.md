---
name: show-me-your-work
description: "Keep a reviewable decision log (what, why, evidence, result) for long or unattended work, audited and reviewed before hand-back. Use for autonomous runs, hillclimbs, bespoke playbooks."
---

# Show me your work

Keep one canonical log. Adapted from poteto's pstack (MIT).

## The format

A single TSV file, one row per decision. Cells stay single-line. Evidence is a pointer, not prose.

Copy [references/decision-log-template.tsv](references/decision-log-template.tsv) (the header row) to start a clean log. Columns:

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words. If a principle drove it, say it plainly, not as a jargon tag.
- **evidence.** A pointer that proves it: a jj change id, a PR number, `file:line`, or an artifact, trace, or screenshot path. Never a paragraph.
- **result.** The outcome or predicate state: `tests green`, `abandoned`, `pixel-diff 0`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance.

```
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components and roughly 75 hours	wanted to know the size before starting a long run	jj qzvmtkpo	found 5 things to sort out before starting
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new and catch any visual change	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	jj ktwrosyl, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	jj abandon nmxqlkvu	abandoned, tightened the brief for next time
```

## Logging a row

Write each entry the way you'd tell a teammate what you did. Plain words, concrete actions, no AI speak or abstract jargon (`tstack:unslop` applies to log text too).

Use the helper:

```
${CLAUDE_SKILL_DIR}/scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>
```

It stamps `ts`, writes the header on first use, strips stray tabs and newlines, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote. A bare `printf` appending a row works too, but mind those same bytes if cells come from generated or user-supplied text.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or an abandoned change with its trigger, a blocker surfaced, a gate fixed. For loop runs, one row per iteration. Skip the trivial and self-evident.

A run is one Claude Code session, including its later turns and any compaction of it. A pickup, a replacement agent, or a new session starts a new run. When a run adds to a log that already has rows, its first row has phase `start`, and so does its first row after another run's `start` row. So a run that comes back to a log in a later turn first reads the log's last rows to see whether another run wrote since. A `start` row names the `ts` range of the rows before it that this run did not write, and its evidence names this run: `session ${CLAUDE_SESSION_ID}`, or the worker's lane for a fleet worker. Use phase `start` for nothing else.

## Where it lives

By default the log is a working artifact, not committed: `decisions.tsv` in the session's scratchpad directory, or `<scratchpad>/audit/<task-slug>.tsv` when several efforts run at once. The reply names its path.

Commit it only when the stakes need the trail to be auditable later (a big port or migration, work a reviewer must trust without re-running it): `.audit/<task-slug>.tsv` in the repo, in its own jj change on top of the work, described like the rest of the stack.

## Rules

- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by committed scripts over hand-made one-offs (Encode Lessons in Structure, `tstack:principles`).

## Audit the log against the transcript

At the end of the run, before handing back, check the log told the truth. This run's transcript is:

```
python3 ${CLAUDE_PLUGIN_ROOT}/skills/productivity/recall/scripts/sessions.py path ${CLAUDE_SESSION_ID}
```

It looks for this session's id in this project's transcript folders (`~/.claude/projects/<slug>/<session-id>.jsonl`) and opens no other session's file. Never glob or read across `~/.claude/projects/*/`: other projects' transcripts are unrelated private work. `sessions.py digest <path>` gives the timeline; grep the raw JSONL for a row's evidence.

Walk this run's rows against what actually happened. Each stretch of them begins at one of this run's `start` rows, or at the first row if this run created the log, and ends at the next `start` row of another run:

- Check that every row maps to a real decision or action.
- Check that each row's evidence resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but isn't logged is a gap. Add it.

Correct the log, not the story. The audit never edits or removes a row, even an invented one. When a row records neither a real decision nor a real action, or its claim or evidence is wrong, add a row that supersedes it with what actually happened and a pointer that resolves. This audit does not check rows outside this run's stretches. If this run's own work shows one of them is wrong, supersede it like any wrong call.

## Fresh review of the trail

Before handing back, spawn a reviewer that did not do the work: a `general-purpose` agent with a fresh context, playing the Decider role ([MODELS.md](../coordinator/MODELS.md)) for a trail from a long absence (a night, more than a couple of hours) since it is the one decisive read of that work, else the Reviewer role; when the Decider's model is unavailable, it takes the role's fallback and the reviewer line says so. Self-review is not a substitute. Its brief: the log path, the transcript path, the task's goal, and the four checks below; it writes nothing. It reads the trail and the transcript, then flags what Luiz should pay attention to. Not a redo of the work, a scan for what's suboptimal or risky.

- Decisions logged with weak or absent evidence.
- Verification steps skipped or claimed without proof in the transcript.
- Choices that look risky in hindsight (premature, scope-creeping, papering over a symptom).
- Gaps Luiz would otherwise miss on a casual skim.

Every reply for a run that produced a trail ends with an "Attention" section. Lead with the reviewer on its own line (`reviewed by <model>, fresh context`), then list each flag pointing to specific rows or moments. "No flags" is a valid value. The reviewer line is not optional.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. GitHub renders a committed TSV as a table; in nushell, `open decisions.tsv` does.

## Composing this skill

Other skills route their audit trail here instead of inventing one. Reference it by name (`tstack:show-me-your-work`) and let it own the format. Don't restate the columns.
