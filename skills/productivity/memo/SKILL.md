---
name: memo
description: Record durable memory with memo. Use when a session learns a decision, gotcha, preference or open thread worth keeping, corrects or closes one, or memo prints a compaction task.
---

memo is the repo's memory: one-line notes written on purpose, shown to every later session at start (the _wake_). The command is `memo` (on the Bash PATH through the plugin's `bin/`; the wake names the full path when it is not). The design is [docs/design/memo.md](../../../docs/design/memo.md).

## What earns a note

A note is a **lesson**: what the next session would otherwise pay to rediscover. Write it the moment it is learned, before the next unrelated action.

| kind | the lesson | example |
|---|---|---|
| `decision` | a choice and its reason | `Chose TOML front blocks over YAML because tomllib is in the stdlib` |
| `gotcha` | a trap and how to avoid it | `A PreCompact hook's stdout becomes compaction instructions; it never reaches the agent` |
| `preference` | how Luiz wants things done | `Commands handed to Luiz are nushell, never bash` |
| `fact` | a durable truth the code does not state | `Staging deploys from the tailnet box, not CI` |
| `open` | a thread left unfinished | `PreCompact wording untested on a real compaction` |

The line is self-contained, one sentence, at most 280 characters: a reader with no context understands it. State the outcome and the why ("Chose X over Y because Z"), never the story ("looked into X, then tried…").

A `gotcha` a linter could catch is also a `tstack:lint-evolve` candidate, with the note's id as its evidence.

Leave out what already has a home: narration of the session, what the code, a comment, the docs or `jj log` already say, anything true only for this session. A note lands in `.tstack/memo/` and is committed with the work: everyone who reads the repo reads it, company repos included. Secrets never go in a note; name where the secret lives instead (memo refuses text that looks like a key or password).

User- and machine-wide lessons (a preference that holds in every repo, how this machine is set up) take `--global`; outside a repo every note is global.

## Commands

```
memo note <kind> "<line>" [--ref <change id|path>]... [--pin] [--global]
memo supersede <ID>... "<line>" [--kind <kind>] [--unpin]
memo pin <ID> [--unpin]
memo open ["<line>"]              # list open threads, or open one
memo summarize <ID>... "<line>"   # answer a compaction task
memo recall <words> | zoom <ID> | export | doctor
memo import <file.tsv> [--cwd <repo>] [--global] [--dry-run]   # reviewed notes, each at its original date
```

IDs are the short tails shown at wake, e.g. `(Q4KT23)`.

## Correcting and closing

A stale line is corrected, never edited in place: `memo supersede <ID> "<the true line>"`. The wake then shows only the new note; the old one stays on disk for `recall`. An `open` thread is closed the same way, with its outcome as the new line (it becomes a `fact`; pass `--kind decision` when the outcome is a choice). Superseding carries a pin over unless `--unpin`.

## Pins

A pin is a standing rule, shown at every wake no matter how old: `--pin` on the note or `memo pin <ID>`. Pins and open threads together may take half the wake's budget, and memo refuses past that: close a thread or unpin a rule first.

## Compaction tasks

When the wake nears its budget, `memo note` prints one task:

```
memo compaction task: before your next unrelated action, summarize these 16 notes into ONE self-contained line ...
then run: memo summarize 7CK8SN HVG8YH ... "<line>"
```

Answer it right away with the listed IDs, unchanged: one line that keeps the decisions and gotchas and drops the rest. If memo says the items are already summarized (another agent or a merge got there first), it offers the next bucket; answer that one instead. A fleet worker (`TSTACK_ROLE=worker`) neither writes notes nor gets tasks: it puts what is durable in its report and its coordinator notes it.
