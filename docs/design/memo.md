# memo: tstack's memory

Status: draft for review. Replaces claude-mem (D5 in [tstack-plan](../tstack-plan.md)).
Open choices are marked **[choose]**; everything else is the proposal.

## What it is for

An agent that starts a session in a repo should know, in a few hundred lines at
most, what the last sessions learned and decided there: the decision taken and
why, the gotcha that cost an hour, the preference Luiz stated, the thing that is
half done. It should not know the narration of every tool call.

claude-mem gets this backwards. It captures everything automatically (a Haiku
call per tool use, 27.8k observations, 70% "discovery" and "change"), spends
Luiz's weekly allowance doing it, and injects 50 titles that are mostly noise.
Its useful part is search over the past, which memo keeps by other means.

## Principles

1. **Deliberate, not automatic.** A memory is written on purpose, by the agent or
   by Luiz, when something durable is learned. Nudges make it hard to forget
   (hooks below); nothing records on its own.
2. **Small and bounded at wake.** Storage grows; what is injected does not.
3. **No daemon, no per-tool-use LLM calls.** Hooks are short Python processes.
4. **jj-native scope.** A repo's memory is the same from every jj workspace.
5. **Fleet-safe.** Many agents may read at once; writes never corrupt or collide.
6. **Clean room.** OptMem has no license: the ideas (append-only log, summary
   tree, fixed-size wake) are reimplemented, no code is copied.

## The note

A note is one line of at most 280 characters plus metadata:

| field | meaning |
|---|---|
| `id` | ULID (sortable by time, unique without a lock) |
| `kind` | `decision` · `gotcha` · `preference` · `fact` · `open` (unfinished thread) |
| `text` | the memory, self-contained: "Chose X over Y because Z", not "did the thing" |
| `scope` | `project:<owner>/<repo>` or `global` |
| `by` | session id and role (`interactive`, `coordinator`, `manager`) |
| `refs` | optional: jj change ids, file paths, decision ids from the ledger |
| `supersedes` | optional: ids this note corrects or closes |
| `pin` | optional: always shown at wake (a standing rule) |

`supersedes` is what OptMem lacks: a stale fact is corrected by a newer note,
and wake shows only the newest, so the memory does not contradict itself. An
`open` note is closed by a note that supersedes it.

## Where it lives (decided: in the repo)

A file is a TOML front block between `+++` lines, then the one-line text:
`id`, `kind` (`summary` for a summary, which adds `level` and `covers`), `scope`,
`by`, `at`, and optional `pin`, `refs`, `supersedes`.

Project memory lives in the repo, committed with the work:
`.tstack/memo/notes/<ulid>.md` (one file per note) and
`.tstack/memo/summaries/<ulid>.md` (one file per summary). One file per item
means two agents or two machines never produce a textual conflict. Memory
travels with the repo to every machine and collaborator, shows up in review,
and `jj log` explains it. A note is visible to whoever reads the repo, company
repos included; the `memo` skill says so, and secrets never go in a note.

Global memory (user and machine facts) lives in
`$XDG_DATA_HOME/tstack/memo/global/` with the same layout.

A local SQLite index (`$XDG_CACHE_HOME/tstack/memo.db`, FTS5) is rebuilt from
the files when they change (mtime and file-count check at wake). It is a cache,
never the source of truth.

## Scope resolution

1. `jj workspace root` (falls back to `git rev-parse --show-toplevel`, then to
   "no project": global only).
2. In a secondary workspace, `.jj/repo` is a file pointing at the main repo;
   follow it, so every workspace of a repo shares one memory.
3. Key: the `origin` remote normalized to `owner/repo` (`jj git remote list`);
   without a remote, the main repo's path. Never the cwd.

## Compaction (decided: the agent summarizes)

Wake has a budget (default 120 lines for the project, 20 for global). When the
live notes exceed it, older notes are summarized by the agent that is writing,
OptMem's way, with no extra model call:

- `memo note` prints, after the note is stored, at most one compaction task:
  "summarize these 16 notes into one line: …, then run `memo summarize
  <ids…> "<line>"`". The agent does it before its next unrelated action. One
  task per note at most, so the work stays proportional to writing.
- A summary lists the exact ids it covers (notes or lower summaries). Buckets
  are never positional ("notes 1-16"): notes written on two machines interleave
  after a merge, and explicit id lists stay correct through that. The task
  always offers the 16 oldest items not yet covered at the lowest level.
- If a summary for an overlapping set already exists (another agent got there
  first, or a merge brought one in), `memo summarize` refuses and memo offers
  the next bucket; two summaries that overlap after a merge are both kept and
  wake uses the one covering more.
- `memo tasks` lists every pending bucket at once (the ones `memo note` would
  hand out in turn, made of items that exist now), for a backlog such as the
  one `memo import` leaves; no two share an id, so several agents can take one
  each.
- Fleet workers (`TSTACK_ROLE=worker`) never get compaction tasks; neither does
  a session with the hint suppressed (`MEMO_QUIET=1`).
- Summaries form a tree (16 notes, 16 summaries, …); wake shows recent notes
  verbatim and older periods as progressively coarser lines, and
  `memo zoom <id>` walks down. `memo wake` never blocks on a missing summary: an
  uncovered stretch over budget is shown as its newest notes plus a count.

## Wake

A SessionStart hook (startup, resume, clear, compact) prints, as injected
context:

1. A five-line usage block (how to note, when to note, how to recall).
2. Pinned notes.
3. Open threads (`open` notes not yet superseded).
4. The project's summary spine and recent notes, newest last, within the budget.
5. Global notes, within their budget.

Typical cost 2-4k tokens, capped near 6k. A compaction re-wakes, so memory
survives it. Fleet workers do not wake (their coordinator puts what matters in
the brief); a coordinator wakes like any session.

## Writing, and the nudges

- `memo note <kind> "<text>" [--ref …] [--supersedes id] [--pin]`, exposed by the
  `memo` skill, which also says what is worth a note and what is not (no
  narration, no facts the code or `jj log` already hold).
- **Stop hook** (documented to return `additionalContext`): at most once per
  session, when the session did real work (Edit/Write/MultiEdit, or a
  `jj describe`/`commit` in Bash) and wrote no note, remind it once. The added
  context gives the agent one more turn, so headless runs (`claude -p`, SDK:
  `CLAUDE_CODE_SESSION_ATTENDED=0`) are skipped: the extra turn would replace
  their final result.
- **PreCompact hook**: exists in 2.1.285 (input `trigger` manual|auto,
  `custom_instructions`) but cannot reach the agent: its stdout is appended to
  the compaction instructions. So it asks the summary to list unnoted durable
  items under "Memo candidates", and the wake after a compaction
  (`source: compact`) tells the agent to note them.
- Workers (`TSTACK_ROLE=worker`) cannot write; they report, and their
  coordinator notes what is durable.
- Luiz can note directly: `memo note preference "…"` from the shell.

## Recall

The `recall` skill answers "what do we know about X / what happened with Y":

1. memo's FTS index (notes and summaries, all scopes).
2. `jj log` over the repo: descriptions carry the why.
3. The archived claude-mem database, read-only (`sqlite3 'file:…?mode=ro'`),
   which already has full-text indexes over 27.8k observations.
4. Ledgers of past fleets, when the question is about fleet work.

It returns a short cited answer and never injects raw dumps.

## Migration from claude-mem

1. Stop capture (disable the plugin); the worker and Chroma stop with it.
2. Move `~/.claude-mem` to an archive folder; keep `claude-mem.db` read-only
   for recall; drop `chroma/` and `logs/` (1.6 GB).
3. Per project, one distillation pass: the 1,074 `decision` rows plus the
   `learned` field of session summaries become at most 50-100 notes, reviewed
   by Luiz before import. `memo import <file.tsv>` loads a reviewed file
   (`date kind pin text sources`, tab-separated): all lines valid or nothing
   written, each note at its original date, idempotent, no compaction tasks.
4. Remove claude-mem from aimgr and the plugin list.

## CLI

`memo wake | note | recall <query> | zoom <id> | open | pin <id> | supersede <id>
| summarize <ids> <line> | tasks | import <file> | export | reindex | doctor`,
one Python file with the standard library only (`sqlite3`, `tomllib`), shipped
in the plugin at `scripts/memo`.

## Tests

The store is a state machine, so it gets the ladder's rung 5: a model-based
test drives random sequences of note, supersede, pin, summarize and wake
against a trivial in-memory model and checks that wake never exceeds its
budget, never shows a superseded note, always shows every pin and open thread,
and is stable across a reindex. Concurrency: N processes writing at once
produce N notes and a consistent index.
