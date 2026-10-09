# tape: the record of every session, beside memo

Status: draft for review, with the advisor's ruling of 2026-10-08 folded in
(sections 7 and 8 say what it settled). Phase 1a and Phase 1b are built:
`scripts/tape`. Phase 1b's numbers are in [Phase 1b results](#phase-1b-results).
Composes with [memo](memo.md); replaces nothing. Each claim is labelled
**measured** (run on this machine, 2026-10-08), **sourced** (a document says
so) or **inferred** (our reasoning).

## What it is for

memo holds what an agent chose to remember. tape holds everything else: a
bounded, coarse-to-fine view of every session in a project, old work in a few
lines and recent work in many, where any line opens into the lines it was made
from, down to the turn itself. One project reads as one chat that never ends.

The idea comes from Victor Taelin's UniiChat recipe (gist `91837951`, revision
`3c190e06`, 2026-10-08 01:58 UTC, the latest). The gist has no license: tape
takes its ideas, not its text or code. That is memo's clean-room rule
(principle 6).

## Principles

memo's principles hold (bounded wake, no daemon, jj-native scope, fleet-safe,
clean room), with two changes:

- **Automatic, not deliberate.** tape records every turn; memo stays the only
  place for deliberate memory. Model calls are per turn, never per tool use,
  batched by a short-lived builder that exits when its queue is empty.
- **Local only.** Nothing made from a transcript goes into the repo. memo is
  committed; tape is not.

## 1. How it composes with memo

| question | answer | reason |
|---|---|---|
| What goes where | memo: decisions, gotchas, preferences, open threads, written on purpose. tape: what happened, turn by turn, written by the builder. | memo is small because it is chosen; tape is complete because it is not. |
| tape line cites memo | Yes. A turn that ran `memo note` keeps the note's id; the compaction rules copy ids exactly. | memo ids are stable and committed, so the reference never dangles. |
| memo note cites tape | No. Use the session id and date in `refs` if needed. | tape ids are per machine and local; in a committed note they dangle for every other reader (inferred). |
| Wake order | memo first, tape second. | A note is a ruling; a tape line is evidence. When they disagree and the tape line is newer, the agent proposes `memo note --supersedes` and does not act on the tape line. |
| Budget | Two budgets: memo keeps its 120 lines; tape gets 8-16 KB. | One shared budget would let a busy week push decisions out of the wake. |
| Search | `memo recall` stays memo-only. The `recall` skill adds `tape search` as a source after memo and before `jj log`, and its catch-up starts from `tape view`. | memo's FTS is the deliberate record and should not fill with narration. Catch-up today mines every transcript with Readers; the view is that work done once. |
| Writing notes | tape never writes a memo note. | memo principle 1. A later phase may list memo candidates (Phase 4); an agent or Luiz still writes them. |

## 2. Scope and storage

**Recommendation: per project, per machine, local under XDG.**

```
$XDG_DATA_HOME/tstack/tape/<owner>__<repo>/      mode 0700
  tape.db   SQLite: per transcript, its project key and the byte offset read;
            per finished turn, {i, session, file, offsets, from/to uuid, at,
            end, digest, leaf}; FTS5 over the leaves. Phase 1b adds nodes and
            the saved view.
  lock      flock target for the builder
```

- **Not in the repo.** Transcripts hold whatever a session saw: client case
  material in the custom-mcp-servers repos, tool output with tokens or
  personal data (inferred from those repos' purpose). A committed summary
  would publish it to every collaborator. memo's notes are reviewed by their
  author before they exist; tape's lines are not.
- **Data, not cache.** The digests outlive the transcripts and nodes cost
  model calls, so `XDG_DATA_HOME`, mode 0700, search index included.
- **Pointers plus the clipped digest.** A turn points into
  `~/.claude/projects/<slug>/<session>.jsonl` and also keeps its digest (at
  most 32 KB: what a model would see), so zoom and audits survive
  `cleanupPeriodDays`. `tape zoom --raw` reads the transcript while it
  exists.
- **One project, many slugs.** Each jj workspace has its own slug (measured:
  `luizhcrocha/skills` has `-skills`, `-skills-fleet6`, `-skills-lang-c`). The
  builder resolves each transcript's `cwd` to memo's project key, never the
  slug, and merges every workspace of the project into one sequence. A turn
  whose prompt ran in another project's `cwd` is skipped. Subagent
  transcripts and headless (`claude -p`) sessions are left out.
- **Every project, one store each.** A repo with no origin is keyed by its
  path, as memo's key is; a session outside any repo gets no store. No
  search or view crosses projects. `index.db` beside the stores caches which
  project each transcript belongs to.
- **Multi-machine.** Each machine summarizes its own transcripts. A session
  on the Mac does not see the Linux box's tape. memo already carries what
  must travel. Trees are never synced (settled, section 8).

**The log's retention is the weak point.** Claude Code deletes transcripts
after `cleanupPeriodDays` (default 30, sourced: Claude Code settings docs).
The oldest record on this machine is from 2026-09-08 (measured), so the
default is in force. After cleanup, nodes and digests survive but
`zoom --raw` fails. Recommendation: raise `cleanupPeriodDays` in the
dotfiles, to 3650 (done, Luiz, 2026-10-08). The cost:
3.8 GB of transcripts for 30 days, 3.0 GB of it custom-mcp-servers
(measured), so about 45 GB a year at this pace (inferred).

## 3. Data shape

### The unit is a turn, not a message

UniiChat makes each message a leaf. Here that is one Haiku call per tool
call and per tool result, which is claude-mem's pattern that memo rejected.
Measured over the last 14 days, all projects, main sessions:

| unit | per day (mean) |
|---|---|
| messages kept (user, reply, tool call, tool result) | about 5,000 |
| of those over 512 bytes (need a model call) | about 2,400 |
| turns (a typed prompt to the next one) | 411 |
| subagent messages | about 16,000 |

**Recommendation: a leaf is a turn**, about 12 times fewer calls: the
user's prompt, the agent's replies, each tool call and its clipped result,
and subagent reports. With each tool call and result clipped to 2 KB, a turn
is p50 7.2 KB, p90 22 KB, p99 62 KB (measured). A turn over 32 KB becomes
consecutive leaves split at message boundaries; the user's words are never
clipped.

### What a leaf keeps

| record | keep | how |
|---|---|---|
| typed user prompt (`user`, string content) | yes | whole, never clipped |
| assistant `text` | yes | whole |
| `tool_use` | yes | name and input, clipped to 2 KB |
| `tool_result` | yes | head and tail, 2 KB in all; errors kept whole up to 2 KB |
| Agent tool result (a subagent's report) | yes, as `work` | clipped to 8 KB |
| `thinking` | no | UniiChat drops it too: little beyond the replies, and it drew safeguard refusals in the author's runs (sourced: the gist) |
| `<system-reminder>`, `<command-name>`, hook `attachment`s, skill listings | no | harness noise, repeated every session |
| `mode`, `permission-mode`, `queue-operation`, `file-history-*`, `cost-state`, `bridge-session` | no | state, not events |
| `ai-title` | metadata | the session's label in `tape status` |
| compaction and `away_summary` records | no | they restate turns tape already has |
| subagent transcripts (`<session>/subagents/*.jsonl`) | not leaves | their report is in the parent turn; `tape zoom <i> --agent <id>` opens one |

Record types are from one 2.6 MB transcript (measured); every event carries
`sessionId`, `timestamp`, `cwd`, `uuid` and `isSidechain`. The leaf renderer
reuses `sessions.py digest`'s parser.

### The Phase 1a leaf, with no model

Phase 1a makes no model call. Each turn's leaf is built from its
`sessions.py digest` lines, at most 512 bytes, in this order: the session's
first 8 characters, the date, the head of the user's prompt verbatim, the
files edited, the error count, and the head of the final reply. The stored
digest is the same parser's output for the turn, clipped to 32 KB (prompt
first, then head and tail). It leaves tool output out, as `digest` does; a
Haiku leaf in Phase 1b may want it.

### Order, nodes, tree

- A turn is finished when a later prompt arrives in its transcript or 24 h
  pass after its last record. Not at session end: a resumed session appends
  to the same file. A finished turn gets id `i` at ingest, in order of its
  end; ids never change. Parallel sessions
  interleave, so each leaf starts with its session's first 8 characters.
- `node(l, i)` covers turns `i·2^l` to `(i+1)·2^l - 1`, named `id+n` as in
  UniiChat (`40+8`). Binary, built once, never rebuilt.
- At most 512 bytes per node. A source that already fits is its own node,
  with no call (rare for turns: p50 7 KB).

### The view

The view is a list of nodes covering every turn, oldest first, one line each:

```
<tape project="coelhorocha/skills" machine="nixos" turns="0..903">
0+256 09-08..09-19|...
256+128 09-19..09-24|...
...
903+1 10-08|...
</tape>
```

Taken from UniiChat's latest revision:

- **Which pair merges:** the most due pair, due being how long ago the
  pair *ended* measured in its own line size; oldest wins a tie.
- **When:** append one line per turn; once over the high mark, merge in one
  batch down to the low mark. The view is saved in `view.json` and never
  rebuilt from the log.
- **Only summaries,** never a whole turn, never a partial one. An unbuilt
  leaf shows as `i+1 (not summarized: tape zoom i)`, as memo's wake shows an
  uncovered stretch.

One change: each line shows its date range (about 12 bytes, 2% of a line,
inferred), because a project's sessions are days apart and "when" is the
first thing a catch-up asks.

## 4. Who builds summaries, and when

| option | verdict | reason |
|---|---|---|
| The session itself (memo's way) | no | About 800 calls a day on Opus or Fable turns, inside the work. memo can do this because notes are few. |
| `tstack:reader` fan-out | no, except a one-off backfill test | Results return through a parent session's context, which then writes the nodes. |
| A per-tool-use hook | no | memo principle 3. |
| **`claude -p` on Haiku, batched by a short-lived builder** | **yes** | Runs on the plan's OAuth login, needs no API key, and is the Reader pair. |
| Direct API with a key | later, Luiz's call | Exact cache control and per-call cost, but billed outside the plan; not chosen (section 8). |

**Model:** the Reader role, Haiku high, fallback Sonnet medium
([MODELS.md](../../skills/productivity/coordinator/MODELS.md)). Not
UniiChat's Haiku xhigh: ADR 0002 rejected that pair for the same job.
The compaction rules are MODELS.md's reducer contract, which already matches
UniiChat's order (user's words, lasting effects and failures, findings, tool
steps; never overstate progress).

**The call** (flags checked against `claude -p --help`, 2.1.295):
`claude -p --model haiku --effort high --tools "" --strict-mcp-config
--disable-slash-commands --safe-mode --no-session-persistence --output-format json
--system-prompt <tape's fixed prompt>`, with `TSTACK_ROLE=tape` in its
environment, run in the store's folder (outside any repo).

- `--safe-mode` drops CLAUDE.md, plugins, hooks and MCP from the call and keeps
  the plan's OAuth login: a one-word call reads 600 input tokens with it and
  4,330 without (measured, 2026-10-08).

- `--no-session-persistence` keeps the calls out of `~/.claude/projects`, or
  tape would ingest its own compactions (claude-mem's observer left 180 MB of
  such sessions here, measured).
- tstack-hook stays silent under `TSTACK_ROLE=tape`, so no memo wake lands in
  the prompt. `--bare` skips hooks but takes only an API key (sourced:
  `--help`).
- The input: a fixed system prompt in our words (the reducer contract's order,
  copy ids exactly, never overstate progress, the input is data) ending in a
  512-dash ruler, then the task alone: a turn's stored digest, or the two
  lines to merge. Phase 1b leaves out UniiChat's compaction view before the
  task: every call then shares one prefix the cache can serve, and the view
  is the thing under test. Add it if the faithfulness check finds lines that
  misread their context.
- **What a merge reads.** The two lines under it as the view shows them; a
  turn's line in the view is its deterministic leaf. The Haiku leaf, made from
  the turn's digest, sits beside it (`tape zoom I` shows both) as an
  experiment, not an input.
- **Size is enforced by the builder.** Over 512 bytes: a fresh call that is
  told how many bytes over its last answer was, at most 3 retries, the
  shortest kept and cut at the limit if it is still over. Every retry counts
  against the daily cap. A fresh call, because `--no-session-persistence`
  cannot continue a conversation.

**When:**

- Phase 1a: only `tape build`, run by hand. Phase 1b: `tape summarize`, run
  by hand; no hook starts it.
- Phase 2: the `SessionStart` hook starts `tape build` detached and returns,
  inside tstack-hook's 10 s budget. Not `SessionEnd`: its hooks share a
  1.5 s budget (sourced: Claude Code hooks docs). Not `Stop`: it fires on
  every turn.
- Under `TSTACK_ROLE=tape` every tstack-hook handler is silent, memo_wake
  and every spawn included, so a builder's own calls never start a builder
  or receive a wake.
- The builder takes a non-blocking `flock` on the project's `lock`; if it is
  held, it exits and the running builder picks up the new turns. So there is
  one builder per project per machine, and machines share nothing.
- Up to 4 calls at once per builder (UniiChat runs 8; fewer here to leave
  the plan's rate limit to Luiz's sessions, inferred). Ready nodes sit in a
  queue; the builder never scans the tree for work.
- **Failure:** a failed call leaves its node unbuilt and queued. The next
  build retries it. A usage limit stops the builder, records the time and
  releases the project's lock; the next `SessionStart` after it retries.
  The view never waits on a node.
- **Daily cap:** `max_calls_per_day` per project in
  `$XDG_CONFIG_HOME/tstack/tape.toml` (default 300). Over it, the builder
  stops and `tape status` says so.

**Cost per day of work (inferred, from measured counts):**

| item | estimate |
|---|---|
| leaf calls | about 420 (411 turns, 3% split) |
| merge calls | about 420 (a binary tree has one merge per leaf) |
| size retries | 10-20% more |
| input tokens | about 1.3 M uncached (turn digests, mean 11 KB) plus about 3 M read from cache (compaction views) |
| output tokens | 0.4-1.7 M (a 150-token line plus thinking at high) |

custom-mcp-servers holds 86% of those turns (measured: 4,973 of 5,761 in 14
days); `coelhorocha/skills` has about 30 a day (measured: 423 in 14 days), so
about 60 calls. Haiku's output costs a twentieth of Sonnet's per token
(sourced: MODELS.md); how the plan counts Haiku against the weekly allowance
is unknown, and Phase 1b measures it. Backfilling the 30 days on disk is about
25,000 calls for every project, 1,800 for `coelhorocha/skills` (inferred).

## 5. What a session sees, and how it zooms

| | memo | tape |
|---|---|---|
| injected at SessionStart | yes (now) | Phase 3 only, opt-in per project |
| budget | 120 project lines + 20 global; 51 lines, 11.6 KB in this repo today (measured) | 8-16 KB, sawtooth; about 2.5-5k tokens, 16-32 lines (inferred, 3.5 bytes a token) |
| fleet workers | do not wake | do not wake |

UniiChat's 64-128 KB view is the whole context of a fresh turn. Here it is a
supplement to CLAUDE.md, skills and memo in a session that keeps its own
context, so it gets an eighth of that. A bigger view is one command away.

CLI (`scripts/tape`, one Python file, standard library only, like memo):

| command | does |
|---|---|
| `tape view [--bytes N]` | prints the view. Phase 1a: the newest leaves within 8 KB and a count of the older ones. Phase 1b: the saved view and the newer leaves, within the high mark by default; over a smaller budget it folds through nodes already built, then drops the oldest lines for a count |
| `tape summarize` | Phase 1b: ingest, then build the batch's merges and the Haiku leaves on Haiku, 4 at once, under the daily cap |
| `tape zoom <id+n>` | the node's line, then the two lines under it, each with its id; a turn under it also shows its Haiku leaf |
| `tape zoom <i>` | the turn's stored digest |
| `tape zoom <i> --raw` | the turn's records from the transcript, while it exists |
| `tape search [--nodes] <words>` | FTS5 over the deterministic leaves; `--nodes` adds the Haiku lines (merges and Haiku leaves) |
| `tape build [--project KEY]` | ingest every project, or one; idempotent; refuses an excluded project |
| `tape status` | turns, open turns, skipped transcripts, store size, last build; calls today against the cap, cost today and in all, retries, nodes built and queued, the last usage limit |

The wake block tells the agent: a tape line is evidence of what happened,
zoom before acting on it, and memo's rulings win.

## 6. What not to adopt from UniiChat

| UniiChat | tape | reason |
|---|---|---|
| A fresh model call per user turn, the view the only continuity | No | Claude Code owns the turn loop and its context. tape supplements a session; it cannot replace one. |
| Compactions share the turns' system prompt and tools for the cache | No | Claude Code's system prompt varies by session, plugins and settings (inferred). tape's calls share their own fixed prefix. |
| One leaf per message | No, one per turn | 12 times fewer calls (measured counts above). |
| Zoom as the only way to navigate memory, no search | No | recall, `jj log` and grep are good sources; tape is one of them. |
| 64-128 KB view | No, 8-16 KB | A supplement, beside memo's wake. |
| Haiku xhigh | No, Haiku high | ADR 0002. |
| Chat corrections make most of AGENTS.md unneeded | No | CLAUDE.md, skills and memo stay the rule sources; a correction worth keeping becomes a note. |
| Imported `note` kind | No | memo notes stay in memo; tape cites them. |
| One process owns the chat for its life | No | A short-lived builder per `SessionStart`, behind a non-blocking lock. |
| 8 concurrent compactions | 4 | The plan's rate limit is shared with Luiz's sessions (inferred). |

Taken as is: the append-only log, the binary tree of 512-byte lines, the
due-from-end merge order, the batched sawtooth, the saved view, the ruler
and cut retries, the priority order, dropping thoughts, queues over scans.

### The revision read, and what changed

WebFetch and the GitHub API both returned `3c190e06` (2026-10-08), the
latest. The previous one is `f51fe5c9` (2026-10-04, then called OptChat).
What changed, and whether it moves this note:

| change | moves the note? |
|---|---|
| A pair's due-ness measured from its last message, not its first; the old rule churned old lines | Yes, adopted (section 3). |
| Merges batched (128 KB up, 64 KB down) instead of fitting at every message; about 4 times fewer rewrites | Yes, adopted with tape's smaller marks. |
| View saved and reloaded instead of re-folded from the start at load | Yes, `view.json`. |
| Compactions moved from their own prompt on Sonnet medium to the turns' prompt on Haiku xhigh, with their own 16-32 KB view | Partly: own view yes, Haiku yes, shared turn prefix no, xhigh no. |
| A ruler of dashes replaces a real sample line, which the model copied | Yes. |
| Ready nodes in queues instead of a full scan (quadratic) | Yes. |
| Cache marks on 4-line blocks instead of fixed character offsets; concurrent writers of one prefix wait | No: tape does not control `claude -p`'s marks. Relevant only with a direct API key. |
| Subagent reports get their own `work` kind | Yes, already. |

None of these changes the turn-as-leaf unit, the storage or the composition
with memo.

## 7. Phased plan

**Phase 1a: no model calls (built).** `scripts/tape` ingests Claude Code
transcripts into turns with the deterministic leaf of section 3, FTS5 search
over the leaves, `view`, `zoom` and `status`, per project only. `tape build`
runs by hand. No hook, no network, no injection. Tests in
`scripts/tests/test_tape.py`, a rung-5 model test among them: random ingest
sequences keep every finished turn at exactly one leaf and keep the view a
suffix of the leaves.

**Phase 1b: Haiku, on `coelhorocha/skills` only (built).** `tape summarize`
builds merges, and an experiment with Haiku leaves against the deterministic
ones. Each call records `total_cost_usd` from `claude -p --output-format
json`. The projects it may spend on are `summarize` in `tape.toml` (default
`["coelhorocha/skills"]`); the others keep Phase 1a leaves. The view rules
come with the merges, tested by a second model test (`MergeModelTest`):
random appends, summarize runs and failing calls keep every leaf under
exactly one top node of the saved view, put only built nodes in it, merge
only built nodes, keep its prefix when no batch was applied, and end a run
with no failure under the high mark. A batch is applied once every merge in
it is built; until then the view folds through the merges already built.

**Measure, then decide on Phase 2:**

1. **Needles:** 20 user decisions sampled from the transcripts, at least 5
   from turns over 32 KB. A fresh Sonnet session finds each three ways:
   (i) FTS over the deterministic leaves, (ii) recall's Reader mining,
   (iii) tape `view` and `zoom`. Record hits, zooms per hit and tokens per
   hit.
2. **Faithfulness:** an Opus Reviewer checks 30 random nodes against their
   sources for invented facts and overstated progress.
3. **Cost:** calls, `total_cost_usd`, wall time, size retries, and the
   weekly meter before and after the backfill.

Phase 2 goes ahead only if all hold: (iii) finds at least 18 of 20 with at
most 3 zooms per hit and fewer tokens per hit than (ii); at most 1 invented
fact in 30 nodes; the backfill moves the weekly meter by less than 10%.

**Phase 2: kept current.** The `SessionStart` builder of section 4, the
daily cap, `recall` uses tape. Every project not excluded.

**Phase 3: wake.** tape view after memo's wake, 8-16 KB, opt-in per
project; two weeks with and without, judged by how often sessions zoom and
how often Luiz has to re-explain past work.

**Phase 4, if wanted:** memo candidates (a user correction seen in three
sessions with no note becomes a suggestion in `tape status`, never a note).

## 8. Decisions and open questions

**Settled (advisor, 2026-10-08):**

- No `SessionStart` injection until the Phase 2 numbers are in.
- Trees are per machine and never synced.
- The name stays `tape`.
- Fleet worker, subagent and headless sessions stay out.

**Settled (Luiz, 2026-10-08):**

- **Every project.** Luiz chose all his projects over the advisor's
  two-repo allowlist, client repos included by his call. Each gets its own
  store. `$XDG_CONFIG_HOME/tstack/tape.toml` holds `projects = "all"` (a list
  of keys still works, to record only those) and `exclude = [...]` for a
  project never to record.
- **Billing.** Phase 1b's calls run on Luiz's Claude plan through
  `claude -p`, behind the daily cap. Each call records `total_cost_usd` from
  `--output-format json`, the number for a later switch to an API key.

- **Retention.** `cleanupPeriodDays` is 3650 in the dotfiles (pushed
  8641dc08), so transcripts stay about ten years and `zoom --raw` keeps
  working.

**Open for Luiz (from the Phase 1b results below):**

- Phase 2 does not go ahead on these numbers: Haiku nodes invented 5 facts in
  30, against a bar of 1, and view and zoom found 17 of 20 needles, 10 of them
  within 3 zooms. Keep Phase 1b as it is, try one change and measure again
  (the compaction view as context, Sonnet for merges, or a merge prompt that
  forbids joining facts across items), or stop at Phase 1a. The plain
  `tape search` found 16 of 20 at the same tokens per hit with no model call.
- 197 Haiku leaves are still queued. Running `tape summarize` again on another
  day finishes the leaf experiment in about 220 calls and $0.55.
- The weekly meter: `claude -p` reports no plan usage, and none is stored on
  disk. Compare `/usage` before and after the calls (2026-10-09
  01:31-02:16 UTC) if the plan's share matters.

## Phase 1b results

Measured 2026-10-08 on `coelhorocha/skills` (237 turns from 7 sessions,
2026-09-16 to 2026-10-09), Claude Code 2.1.295, Haiku 5.5 at high effort.

### The backfill

One `tape summarize`. It stopped at the daily cap, as designed.

| item | measured |
|---|---|
| calls | 300 (the cap): 255 for merges, 45 for Haiku leaves |
| nodes built | 221 merges (the whole batch, applied); 40 of 237 Haiku leaves (turns 0-39); 197 leaves queued for another day |
| `total_cost_usd` | $1.3543: merges $1.2428 ($0.0049 a call), leaves $0.1115 ($0.0025 a call). This is the list-price figure `claude -p` reports; the calls were billed to the plan |
| wall time | 44 min 57 s with 4 at once; a merge took 39 s on average (max 176 s), a leaf 17 s |
| size retries | 39 (13% of calls); every node fit within 3 retries; none was cut, none failed, no usage limit |
| tokens | output 2.56 M, nearly all thinking: a merge averaged 9,300 output tokens for a 500-byte line. Input: cache read 208 K, cache write 355 K, uncached 600 |
| the view | 108 KB of leaves became 16 lines, 7,869 bytes: `0+64`, `64+64`, `128+32`, then 16s, 8s, down to single recent turns |
| plan meter | not visible: `claude -p` reports no plan usage and none is stored on disk |

Haiku fills the line: merges came back at 450-510 bytes almost every time.
Thinking at high effort is most of the cost; whether medium effort keeps the
quality is untested.

Before the run: 2 trial calls and 6 smoke calls in a scratch store
($0.010), outside this ledger.

### Needles

20 needles, picked before any search by a Sonnet agent from 28 turns drawn at
random (seed 20261008), each with its answer and source turn. 17 come from
turns over 32 KB raw. Most answers (19) sit in the agent's reply, not in the
prompt's head. Each method ran as one fresh agent with only its tool, and the
answers were graded against the key. A logging wrapper counted every tape
command and its output.

| method | found | zooms or calls per hit | tool output read | agent tokens | tokens per hit |
|---|---|---|---|---|---|
| (i) `tape search` over deterministic leaves, then `zoom I` (Sonnet) | 16/20 | 4.3 calls per needle | 365 KB | 141,870 | 8,900 |
| (ii) recall's Reader mining: one `tstack:reader` (Haiku high) per session batch, 6 in all, all 20 questions at once | 19/20 (N17 wrong; N06 named the change that added pstack, not its base commit: the question allowed both) | a full pass | the 7 sessions' digests are 587 KB, plus greps of the raw transcripts | 488,717 | 25,700 when 20 questions share one pass; a single lookup pays the full pass, about 489,000 |
| (iii) `tape view` and `zoom` over Haiku merges (Sonnet) | 17/20 | median 3, mean 3.6 zooms; 10 hits within 3 zooms | 202 KB (the 7.9 KB view read once) | 150,107 | 8,800 |

Misses: (i) N02, N12, N19, N20; (iii) N02, N03, N20; (ii) N17. Only 5 needle
turns had a Haiku leaf (turns 0-39). For those 5, the answer was in the Haiku
leaf for 3 and in the deterministic leaf for 2.

### Faithfulness

An Opus Reviewer (high effort) checked 30 Haiku nodes, drawn at random (seed
30), against exactly what each call was given: 26 merges and 4 leaves, in
proportion to what was built.

- 5 invented facts in 5 nodes. Two reverse a meaning: `32+8` says decisions
  "stay unread till looked at" where the source says they stay unread even
  after being looked at, and `118+2` says "user finished them" where the
  agent did. One adds a label, "untested", the source does not give (`4`).
  Two misattribute: an error tied to a file edit (`222+2`), and a revised
  decision counted among those awaiting push (`12+4`).
- 1 overstated progress: `106+2` states as done a toolbar fix the source
  hands to an agent.
- 1 user decision dropped: "if it's a fix do it", from `16+16`.

### Against the Phase 2 bar

| condition | bar | measured | met |
|---|---|---|---|
| (iii) finds | at least 18 of 20 | 17 of 20 | no |
| zooms per hit | at most 3 | median 3; 7 of 17 hits took 4-8 | no |
| tokens per hit, (iii) against (ii) | fewer | 8,800 against 25,700 (amortized) or 489,000 (one lookup) | yes |
| invented facts | at most 1 in 30 | 5 in 30 | no |
| weekly meter moved by the backfill | under 10% | not visible | unknown |

**Verdict: Phase 2 does not go ahead.** View and zoom cost about what plain
search costs and far less than Reader mining, but they found one needle more
than search did, below the bar. The Haiku lines are not faithful enough to be
read without zooming: 1 node in 6 has an invented or overstated claim. Most
of these are small, but two of them reverse who did what.
