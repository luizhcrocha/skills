# The fleet: behaviour inventory

What the Python fleet (`skills/productivity/coordinator/scripts/*.py`) does, as the contract the
TypeScript rewrite implements (D13 in [docs/tstack-plan.md](../docs/tstack-plan.md)). Derived from
the code and [DASHBOARD.md](../skills/productivity/coordinator/DASHBOARD.md), and checked against
the 209 Python tests, the 50 page tests, the model-based test and the golden traces in
[oracle/](oracle/).

Since the cutover (D13) the TypeScript `fleet` CLI (`fleet/bin/fleet`) is the fleet: every skill, agent
and hook names it, and nothing tells an agent to run the Python scripts. They stay in the repo as the
oracle only: the golden traces are recorded from them, and the model test, the corpus and their own
tests keep running against them, so a change of behaviour is made in both and checked by the
differential test.

How to read it:

- A rule stated here is pinned: a test, the model or a golden trace fails when it changes.
  Where only this document says it, the rule is marked *(unpinned)*.
- **open-N** marks behaviour that looks accidental, or a bug left for Luiz. Stage 2 decides each
  one on purpose, doesn't copy it blindly, and re-records the traces that show it.
- Paths: `DIR` is a dashboard directory (a coordinator's or the manager's, usually
  `<scratchpad>/coordinator`), `REGISTRY` is `$FLEET_HOME`, else `$XDG_STATE_HOME/fleet-board`,
  else `~/.local/state/fleet-board`, and `SKILL` is `skills/productivity/coordinator`.

Contents: [Environment](#environment) · [state.py](#statepy-the-ledger-cli) ·
[The ledger](#the-ledger-statejson) · [Numbers](#numbers-refs) · [Warnings](#warnings) ·
[chat.py](#chatpy-the-chat) · [fleets.py and the registry](#fleetspy-and-the-registry) ·
[The other scripts](#the-other-scripts) · [The hub](#the-hub-fleet-hub) · [Heartbeats](#heartbeats) ·
[Workspaces](#workspaces-fleet-ws) · [The advisor](#the-advisor-fleet-advisor) · [Files by writer](#files-by-writer) ·
[Oracle traces](#oracle-traces) · [The model](#the-model-based-test) · [Open](#open)

## Environment

| Variable | Read by | Meaning |
| :-- | :-- | :-- |
| `FLEET_NOW` | every script, through `scripts/clock.py` | an ISO 8601 instant with its offset; stops the clock there. Unset: the machine's clock |
| `TZ` | every stamp | stamps are local time with the offset (`2026-01-05T09:00:00+00:00`), to the second |
| `FLEET_HOME` | fleets.py, usage.py | the registry directory |
| `XDG_STATE_HOME` | fleets.py | the registry's base when `FLEET_HOME` is unset |
| `CLAUDE_CONFIG_DIR` | spend.py | where transcripts are (`~/.claude`): `projects/<project>/<session>.jsonl`, workers under `<session>/subagents/agent-<id>.jsonl` |
| `FLEET_DISCOVER=0` | served.py | skip discovering the machine's served ports (tests) |
| `FLEET_CHECK_S` | chat.py | how often a manager's or coordinator's watch looks at the fleets (default 30 s) |
| `FLEET_UNHEARD_S` | chat.py | how long the user's message waits unread before a manager's watch tells (default 120 s) |
| `FLEET_NUDGE_S` | chat.py | how long a message to a worker waits unanswered before the coordinator's watch tells (default 600 s, L1) |
| `TAILSCALE` | serve_dashboard.py, `fleet hub`, `fleet serve`, `fleet served` | the tailscale binary |
| `FLEET_HUB_PORT` | `fleet hub`, `fleet serve` | the hub's port (default 7420); `--port` wins |
| `FLEET_DIR` | the plugin's hook (`fleet_heartbeat`) | the fleet DIR a session works for when its scratchpad holds none: a worker launched as its own Claude Code process. See [Heartbeats](#heartbeats) |
| `FLEET_WORKER` | the plugin's hook | the worker id such a process is; written into its heartbeat |

A DIR at `…/<project>/<session>/scratchpad/<name>` names a session transcript; any other DIR has
none, and every figure read from a transcript (spend, worker tokens, liveness) is absent.

## state.py: the ledger CLI

`state.py DIR COMMAND [ARGS] [--no-render] [-q]`. One command per event. Create and update share a
verb: an unknown ID with the required fields creates the row, a known ID changes only the fields
given. Every ID argument also takes the row's number (D3, L2, R1) where rows have numbers
([Numbers](#numbers-refs)).

### The run of one command

1. `note` as the command: refused, `there is no \`note\` command: a note is \`event --kind note TEXT\``.
2. `--no-render` and `-q` are removed from argv wherever they appear, values included (open-11).
3. argparse: an unknown command, a missing required option, or a value outside its choices exits
   **2** with usage on stderr, and nothing runs.
4. `DIR` is created (mkdir -p), even when the command then fails (open-17).
5. `state.json` is read. Missing, with any command but `init`: refused, `no state.json in DIR; run \`init\` first`.
6. The command's handler runs on the ledger in memory. A refusal exits **1** with
   `state: <reason>` on stderr, and nothing is written. What the handler says on stdout (`asked d8…`,
   `recorded a1…`, `recorded step s7`) is held until step 9.
7. The [warnings](#warnings) are printed to stderr: the chat's, then live rows, then the Now line.
   `show` ends here.
8. Worker figures are measured from transcripts (`--task-id` rows); numbers are given; `updated` is
   stamped; the ledger is validated. A validation fault exits **1** with
   `render_dashboard: <reason>`, and nothing is written or said on stdout (open-2, fixed).
9. `state.json` is written, then what the handler held is printed (JSON, two-space indent, UTF-8 unescaped, a final newline; key order
   isn't part of the contract). `brief.md` is written from `SKILL/assets/brief.md` when missing
   (`{fleet}` → the CLI's path, `<plugin>/fleet/bin/fleet`; `{skill_dir}` → SKILL; `{dashboard_dir}` → DIR), and so is `standing.md` from
   `assets/standing.md` in a manager's DIR. What the user added to either is kept.
10. Output: with `--no-render`, `state.json updated (<command> <id>)` (the id empty for commands
    without one, e.g. `state.json updated (set )`). Otherwise the page is rendered to
    `DIR/index.html`, `state.json` is written a second time with `updated` stamped again, and
    `rendered DIR/index.html (N agents, updated <stamp>)` is printed (nothing with `-q`).

Exit codes: **0** done, **1** refused (by the handler or the validation), **2** usage.

### Commands

The values each flag takes are in the tables. Unless a row says otherwise, a refusal is
`state: <reason>`, exit 1.

**init** `--project P --goal G [--now TEXT] [--role coordinator|manager]`: creates the ledger:
`status` running, `now` TEXT or `Intake in progress.`, `now_at` = `started` = `updated` = now,
empty `roadmap`, `agents`, `roadblocks`, `decisions`, `events`; `role: "manager"` first when the
role is manager, whose roadmap starts with the landing queue, milestone `landings` ("Landings and
deploys"). Refused when `state.json` exists. Prints no warnings.

**set** `[--status running|paused|blocked|done] [--now TEXT] [--goal G]`: sets what is given.
`--now` stamps `now_at`, even with the same words, and warns about each decision the text
[names by number](#warnings) that is closed.

**milestone** `ID [--title T]`: new: needs `--title`, appended with `steps: []`. Known: `--title`
renames it. Milestones are never removed.

**step** `ID [--milestone M --title T] [--status done|current|pending|blocked] [--agent A|''] [--before S | --after S | --remove REASON]`
- New (ID in no milestone): needs `--milestone` (known) and `--title`; `status` defaults to
  pending, `agent` to null. Appended to the milestone.
- Known: `--milestone` other than its own is refused (`step X stays in M; remove it and record it
  in M2 to move it`); status, title and agent change as given; `--agent ''` clears the agent.
- `--before S` / `--after S` moves it next to S. Refused when S is itself, is unknown, or is in
  another milestone (`step S is in M2, and X is in M1`).
- `--remove REASON` takes an existing step out and logs a note event
  `Step X removed (<title>): REASON`, with the step's agent when that agent has a row.
- `step next --milestone M --title T` records a new step under the next free id and prints
  `recorded step <id>`. The id is the letters of M's last step whose id is letters then digits
  (else M's first letter, lower-cased, else `s`), followed by 1 + the highest number any step of
  the ledger with those letters has (`l17` after `l16`, whichever milestone `l16` is in).
- Validation: a step's agent must be a worker row, except in a manager's ledger, whose steps name
  fleets (`render_dashboard: step X points at unknown agent 'A'`).
- One turn: in a manager's ledger, a step of `landings` made current (new or known) while another step
  of `landings` is current is refused: `l1 (<title>) has the turn: one landing at a time. Close it
  (\`step l1 --status done\`) or give it back (\`step l1 --status pending\`) first`.

**agent** `ID [--task T --milestone M] [--skill implement|diagnosing-bugs|prototype|research|tdd|none] [--model opus|sonnet|haiku|fable] [--lane PATH...] [--status queued|running|blocked|done|failed|stopped] [--tokens N] [--duration-ms N] [--task-id ID] [--report R] [--brief B] [--name N] [--step S] [--log TEXT] [--important]`
- `--milestone`, when given, must be known: `unknown milestone 'M' (the roadmap has: m1, m2)`.
- New: needs `--milestone` and `--task`. Defaults: name = id, skill none, model opus, status
  running, lane [], tokens 0, duration_ms 0, rounds 1, brief "", report "", `started` = `updated`
  = now; `task_id` when given. Logs `spawned` (`--log`, else `Spawned on <model> following <skill>.`).
  `--step S` marks S current with this agent (unknown S refused). Prints
  `recorded ID (NAME); its brief opens with: Read DIR/brief.md first; your id is ID.`
- Known: status `done` → `running` adds a round. `--task-id` sets it and forgets `measured`. The
  fields given are set; `--tokens` or `--duration-ms` set `measured: "by hand"`, after which the
  transcript no longer overrides them. `updated` = now. `--step S` sets S's agent to this worker
  and its status to follow the worker (running → current, done → done, blocked → blocked; other
  statuses leave the step's status alone, open-25). `--log` logs an event whose kind follows the
  status (blocked → blocked, done or failed → reported, stopped → note, else note), important
  when `--important` or the status is failed.
- A model outside the policy (Opus, Sonnet, Fable; `haiku` is the one `--model` takes) is recorded
  and warned about, see [Warnings](#warnings) (L3). The page marks it on the worker's row.
- A worker left done whose report or log reads as unfinished (refused, parked, not met, unmet,
  couldn't, could not, failed to, gave up, incomplete, unfinished, blocked on, waiting on, skipped,
  not done) is warned about on stderr when the command set `--status done` or `--report`. It's
  still recorded.
- Validation: ids match `[A-Za-z0-9_.-]+`; a name has no control character; no id or name
  (case-insensitive) is `user` or `coordinator`, or another worker's id or name
  (`a mention could not tell them apart`).
- Measuring: on every write, each row with a `task_id` whose `measured` isn't `by hand` takes
  `tokens` (output + input + cache writes + cache reads of the transcript's last usage),
  `duration_ms` (first to last timestamp) and `measured` (the transcript's mtime) from
  `subagents/agent-<task_id>.jsonl`, while it is live and once more after (*pinned by test_state
  MeasuredTest; out of the oracle, which has no transcripts*).

**roadblock** `ID [--title T --detail D --severity warning|serious|critical --needs user|coordinator|worker] [--agent A] [--decision D] [--resolved | --open] [--important]`
- `--agent`, when given, must be known (`unknown agent 'A'`, checked first; a manager's ledger takes
  any name), on creation and on update (open-3, fixed).
- `--decision`, when given, must name an open decision, on creation and on update. The number is
  stored as the decision's id.
- New: needs title, detail, severity, needs; `--needs user` also needs `--decision`. Stored with
  `since` = now, `resolved` false. Logs `blocked` (`<title>: <detail>`), important when
  `--important` or needs user, tagged with the decision. The worker named by `--agent` is marked
  blocked.
- Known: `--needs user` refused as on creation when the roadblock would be left without a decision
  (no `--decision`, and none recorded) (L8). The fields given are set. `--resolved` resolves: `resolved` true, logs `resolved`
  (`<title> resolved.`), and its worker, when blocked, goes back to running. This happens again on
  a resolved roadblock (open-4). `--open` sets `resolved` false, with no event and no re-blocking.

**decision** `ID [--kind decision|input|secret|action --title T --question Q --why W] [--blocking | --not-blocking] [--option "KEY: label | consequence"]... [--same-options] [--recommend R --reason WHY] [--secret NAME] [--manual TEXT] [--body FILE | --no-body] [--agent A] [--supersedes ID] [--step S] [--milestone M] [--log TEXT] [--asks user|manager] [--decide ANSWER --resolution HOW | --withdraw REASON]`

Checked in this order:
1. `--decide` without `--resolution`: refused.
2. `--agent` must be a worker row (in a manager's ledger, any name).
3. A closed decision (decided or withdrawn) refuses every change (`<title> is already <status>:
   <resolution>. A closed decision stays as it is; open a new one with --supersedes ID`) except
   `--step` and/or `--milestone` alone, which set where it came from.
4. New: the id must match `[A-Za-z0-9_.-]+`. `--supersedes` must name a closed decision (an open
   one: `<title> is still open; change it instead of superseding it`) and is stored as its id.
   - Recorded after the fact (`--decide` given): needs title and question. Stored with
     `page: false`, kind defaulting to decision, no kind check, no body, no `asked` event, and
     closed at once.
   - Otherwise needs kind, title, question, why, and what its kind shows: **decision** at least
     two options, `--recommend` among the option keys, and `--reason`; **secret** `--secret` and
     `--manual`; **action** `--manual`; **input** nothing more. Kind **grill** is refused here
     (it is opened with `grill`). An option is `KEY: label | consequence` with a key matching the
     id pattern; keys are unique.
   - The row: `kind, title, question, why, blocking, agent, options[], recommend, reason, secret,
     manual, body, page, supersedes, status: open, answer, resolution, change, asks (default
     user), opened, revised, closed, step, milestone`. `--step S` sets step and its milestone;
     `--milestone M` sets the milestone; a worker without either gives its own milestone.
   - `--body FILE` copies FILE to `DIR/decisions/<id>.html` and sets `body` (an unreadable FILE
     is refused).
   - Logs `asked` (`<title>: <question>`, prefixed `For the manager: ` when asks is manager),
     important when blocking and not for the manager, tagged with the decision. Prints
     `asked <id>. Arm its answer's wake now, as a background command (run_in_background):
     \`FLEET chat DIR wait <id>\`: it exits with the user's answer the moment it is given.`
5. Known and open: `--supersedes` is refused. A new `--question` for a choice needs its options
   again (`--option`) or `--same-options`. The fields given are set (an empty value clears);
   `--option` replaces all options; `--blocking`/`--not-blocking`; `--asks` changes who looks
   first; the kind check runs on the result; `--body`/`--no-body` (the latter deletes the file).
   When anything changed, `revised` = now, `change` = `--log`, and an `asked` event is logged:
   `<title> now asks you: <question>` (important when blocking) when `--asks user` passes a
   manager's decision on, else `<title> changed: <--log, or the changed fields>`.
6. `--decide ANSWER --resolution HOW` closes it decided: logs `decision`
   (`<title>: <answer> (<resolution>)`). `--withdraw REASON` closes it withdrawn: logs `resolved`
   (`<title> withdrawn: <reason>`). Either sets `closed` = now and resolves every open roadblock
   waiting on it (each logging its own `resolved`, and unblocking its worker).
7. Validation: ids unique; no id equal to another decision's number; `supersedes` and
   roadblocks' `decision` name existing ids; defaults are filled (`asks` user, `blocking` false,
   `page` true, `body` false, the optional fields null, a grilling's `questions` []).

**grill** `ID [--title T --why W] [--ask "TITLE | QUESTION | RECOMMENDATION | WHY"]... [--of Q] [--answer "Q3: ..."]... [--drop "Q4: why"]... [--revise "Q3: T | Q | R | W"]... [--reason "Q3: why"]... [--blocking] [--agent A] [--step S] [--milestone M] [--done SUMMARY]`
- A known ID that is not a grilling: `X is a <kind>, not a grilling`. A closed one is refused.
- New: needs `--title` and at least one `--ask`; a decision row of kind grill, `question` "",
  `page` true, `questions` [].
- Applied in order: answers (`status` answered, `answered` = now), drops (dropped, `answer` null,
  `dropped` = reason), revisions (back to open with new words, `asked` = now), reasons, then new
  questions `q<n+1>` (`of` = `--of`, lower-cased; `--of` must name a question). A `Q<n>` that
  doesn't exist is refused, as is text without the `Q3:` head. `--ask` needs four non-empty parts.
- `question` becomes `N question(s) to answer` or `Every question is answered`.
- New questions, revisions or reasons log `asked` (`<title>: N new question(s)` / `a question
  revised` / `reasons added`), important when blocking; on a known grilling they stamp
  `revised`. The first round prints the `wait` line.
- `--done SUMMARY` needs no open question (`Q2, Q3 still open: answer them, drop them, or ask
  what is left`) and closes it decided with resolution `grilling finished`.

**event** `[--agent A] [--kind spawned|reported|blocked|resolved|asked|decision|note|integrated] [--important] TEXT`:
logs one event (kind note by default). `--agent` must be a worker row (a manager's: any name).

**park** `[--agent A]... REASON`: every live row (running, queued, blocked), or only the named
ones, becomes stopped with `updated` = now; each current step of a stopped worker goes back to
pending, keeping its agent (open-5, fixed); one note event, `Stopped a1, a2: REASON`. A named
worker without a row is refused; no live row among them: `no worker row is running, queued, or
blocked`.

**keep** `ID [TEXT | --drop REASON]`: `kept[]` (created on first use) holds `{id, text, at}`. TEXT
creates or rewrites; `--drop` removes it and logs `Dropped ID (<text>): REASON`; dropping an
unknown one and TEXT missing are refused.

**link** `ID [--url U --title T] [--kind dev|page] [--decision D] [--agent A] [--note N] | --drop REASON`:
`links[]` (created on first use). `--drop` removes a known one (logs `Link ID (<title>) removed:
REASON`). `--decision` must name a decision, of any status, stored as its id; `--agent` must be
known. New: needs url and title, kind defaults to dev, `since` = now, logs `Page <title>: <url>` or
`Dev server <title>: <url>` tagged with agent and decision. Known: fields given are set.

**show**: prints the ledger and the command cheat sheet; writes nothing. Pinned lines:
`<project> [<status>(, manager)] <now>`; per milestone `  <id> <title> (<done>/<steps>)` and
per step `    <id:<6> <status:<8> <title>( @agent)`; per worker
`  agent <id:<16> <status:<8> <skill:<15> <model:<6> <tokens:>8> tok  lane=<a,b or ->( round N)`;
per roadblock, decision, link and kept note a line with its number; then
`  <N> events, updated <updated>` and the cheat sheet. The cheat sheet lists each command with
the values its flags take.

## The ledger: state.json

Every list is in the order the user reads it. Stamps are `clock.stamp()`.

```
role          "manager" in a manager's ledger, absent in a coordinator's
project, goal, status (running|paused|blocked|done), now, now_at, started, updated
roadmap[]     {id, title, steps[]: {id, title, status (done|current|pending|blocked), agent|null}}
agents[]      {id, name, task, skill, model, status (queued|running|blocked|done|failed|stopped),
               lane[], milestone, tokens, duration_ms, rounds, started, updated, brief, report,
               task_id?, measured? ("by hand" | the transcript's mtime)}
               in spawn order: the page colours by position, so rows are appended, never reordered
roadblocks[]  {id, title, detail, agent|null, severity, needs, decision|null, since, resolved, ref}
decisions[]   {id, ref, kind, title, question, why, blocking, agent, options[]: {id, label, consequence},
               recommend, reason, secret, manual, body, page, supersedes, status (open|decided|withdrawn),
               answer, resolution, change, asks (user|manager), opened, revised, closed, step, milestone,
               questions[]? (grill: {id: "q<n>", title, body, recommend, reason, of, status
               (open|answered|dropped), answer, asked, answered?, dropped?})}
events[]      {at, agent|null, kind, text, important?: true, decision?}   append-only
links[]?      {id, ref, url, title, kind (dev|page), decision, agent, note, since}
kept[]?       {id, text, at}
workspaces[]? {id (the jj workspace's name), agent, path, repo (the default workspace's root),
               base (change id), added, status (active|pruned), pruned?}   written by `fleet ws` only
```

`workspaces` is a key neither state.py nor `fleet state` knows: both keep it as it is (Python
round-trips the whole object, TypeScript keeps a ledger's unknown keys in place), and the page's view
passes it through. No oracle trace has it.

Validation (step 8, every write) requires `project, goal, status, now, started` as strings and
`roadmap, agents, roadblocks, events` as lists, the statuses above, the agent, step, roadblock and
event keys listed, and the decision rules above. It fills the defaults it checks (agents' tokens,
duration_ms, skill, model, brief, report, rounds; decisions' optional fields), so a hand-written or
older ledger comes out complete after one command.

## Numbers (refs)

On every write, each decision, link and roadblock without a `ref` is given one: a letter for its
kind (decision **D**, action **A**, input **I**, secret **S**, grill **G**, link **L**, roadblock
**R**), and 1 + the highest number of that letter already given, skipping a number that another row of
the same list has as its id (open-1). Decisions are numbered in
`opened` order (as instants, open-13; a stamp that does not parse sorts after, as text), links and
roadblocks in list order. A number, once given,
never changes, even when a decision's kind changes (open-7).

Lookup: `find(rows, key)` returns the row whose id is `key`, else the one whose ref is `key`, so an
id always wins (`d3` is an id; `D3` is a number unless a row's id is `D3`). Every command's ID and
every decision reference (`--decision`, `--supersedes`, `chat wait`, `fleets.py decision`) take
either. Where a reference is stored or printed as an address, it's the id.

## Warnings

After the handler succeeds, before validation, on stderr, in this order (not for `init`):

1. **A chat nobody reads** (`chat: the user wrote N message(s) since #S that no watch has read.
   Arm \`fleet chat DIR watch --as <host> --all --resume --once\` as a background command; it prints
   them first.`) when the host isn't listening and the user's messages wait unread. See
   `listening` under [chat.py](#chatpy-the-chat). It reads `state.json` as it was before the
   command.
2. **Live rows in a still fleet** (`state: a1, a2 still read as running/queued/blocked while the
   fleet is paused; if they are not working, \`fleet state <dir> park "why"\` stops their rows in one
   command.`) when the status is paused or done and some row is live.
3. **A stale Now line** (`state: the page's Now line (said N min ago) reads: "<now, 160 chars>".
   If it is no longer what is happening, say it again: \`fleet state <dir> set --now "..."\` (the same
   words also restamp it).`) when `now_at` is 30 minutes old or older (`never stamped` when it's
   missing or doesn't parse), except on `set --now`.

4. **An answer not recorded** (`state: the user answered D3 (<title>) as #14 at 09:12; record it
   before any other work: \`fleet state <dir> decision D3 --decide "..." --resolution "answered on the
   page (#14)"\`, then answer #14 with --re.`), one line per open decision of the ledger the command
   leaves whose answer the user gave on the page after it was opened or last revised (instants), with
   no reply from anyone but the user. Not for `init`.
5. **Decisions left open** (`state: the fleet is done with D1, A2 still open: withdraw each with its
   reason (\`decision ID --withdraw "why"\`), or name it in your last message as left open on
   purpose.`) on the `set --status done` that finds them open.
6. **Lanes that meet** (`state: a2's lane overlaps a1's (running: src/x.ts). A task whose files
   overlap a running lane waits (\`--status queued\`) or joins that worker's queue.`) on an `agent`
   command that gives `--lane`, `--task` or `--status running` and leaves its row running, when its
   lane meets a running or blocked worker's: two entries meet when some path matches both (L7). A
   plain path covers itself and everything under it; in a glob `*`, `?` and `[...]` stay in one
   segment, `**` as a whole segment spans any number of them, `{a,b}` is either. So `src/*.ts` and
   `src/a/b.ts` don't meet; `src/**` and `src/a/b.ts` do, and so do `src/x.ts` and `src/*.ts`.
   Decided on the product of the two globs' automata (`lanes.py`, `fleet/src/ledger/lanes.ts`).
7. **A model outside the policy** (`state: a1 is recorded on haiku, outside the model policy (opus,
   sonnet, fable): spawning it on haiku needs the user's OK.`) on an `agent` command that gives such
   a `--model` (L3).
8. *TypeScript only* (Python's ledger has no `workspaces`, and no trace does): **a done worker's
   workspace not pruned** (`state: a1's workspace a1 still there though its worker is done: bring its
   changes into the stack, then \`fleet ws <dir> prune\` (a dry run, then --apply).`) on every command,
   and on `set --status done` **the workspaces left** (`state: the fleet is done with workspace(s) a1
   not pruned: ...`).

Also from `set --now`: for each `[DAISGLR]<digits>` in the text that names a closed decision,
`state: the Now line names <ref> (<title>) is <status>: check the decision's state before saying
it waits on anyone.` In a manager's ledger, a number after a fleet's name (`infra I2`, or the part
of the name before its first dash: `acme I1`) is looked up in that fleet's ledger, and the
warning names the fleet. And from `agent`: the unfinished-report warning above.

## chat.py: the chat

`chat.py DIR COMMAND`. The store is `DIR/chat.jsonl`, one message per line, appended under an
exclusive `flock`. A line that doesn't parse, or lacks `id` (int), `from` (str), `to` (list) or
`text` (str), is skipped by every reader. A torn last line (no newline) is left alone, and the
next append starts on a new line. Bytes that aren't UTF-8 are read with replacement.

A message: `{id, at, from, to[], text, re (int|null), parts[]}` plus `author` (the user's tailnet
login, set only by the server), `decision`, `quote {text ≤2000, from ≤200}`, `side` (the id of the
message that opened a side chat). `parts` split the text into plain parts and mentions
`{text: "@a1", mention: "a1"}` that join back to the text exactly. `re` and `parts` default to
null and one plain part when read.

**Participants.** The host is `manager` in a manager's DIR, else `coordinator`. The roster is
every `agents[]` row, whatever its status, and in a manager's DIR each coordinator being served,
under its fleet name. `--as WHO` resolves, case-insensitively, the host, then ids, then names.
`user` is refused (`only the dashboard server speaks as the user; use --as <host> or your own
id`), and so is anyone unknown.

**Addressing** (`address`, shared with the server; the cases in
`SKILL/tests/recipients.json` are the contract): each `@token` ([A-Za-z0-9_.-]+) that resolves
is a mention; one that doesn't is retried without trailing dots and dashes (`@a1.` ends a
sentence). Recipients are the mentions, then the sender of the message `re` answers. A message
from the user goes to them, or to the host when there are none; a message from anyone else goes
to `user` plus them. Nobody is their own recipient. An unknown `re` is refused, and so is empty
text.

**Open.** A message is open for each recipient until that recipient sends a message with `re` =
its id.

| Command | Does | Output | Exit |
| :-- | :-- | :-- | :-- |
| `say --as WHO [--re N] [--decision D] TEXT` | appends | the stored line | 1 refused |
| `inbox --as WHO` | the messages open for WHO (`user` allowed) | one line each, oldest first | 1 unknown WHO |
| `log [--after N]` | every message with id > N | one line each | 0 |
| `watch --as WHO [--after N \| --resume] [--all] [--once]` | prints what is open for WHO with id > N (with `--all`, every open message from the user too), then each new message to WHO (or from the user) as it lands | one line each | 0 on SIGTERM or `--once` |
| `wait DECISION...` | waits for the user's answer to one of these open decisions | the answer's line, then `-> the user answered <ref>: record it first, ...` | 1 unknown decision |

A printed line: `#<id> <from>( (<name or author>)) -> <to, each with its name>( [<ref> <decision>])( [side chat #N])( (quoting <from>: "<quote>"))`
`: <text>( [re #N])`. Line breaks print as ` ⏎ `, a tab as a space, and other control characters
are dropped, so a message is always one line.

`watch`: `DIR/watch-WHO.pid` holds its pid while it runs (removed at exit if still its own),
`watch-WHO.cursor` the last id printed (`--resume` starts after it), and `watch-WHO.left` is
touched when it ends. A manager's watch prints `!` lines every `FLEET_CHECK_S`: a fleet that
doesn't read its chat while the user waits more than `FLEET_UNHEARD_S`, an answer a fleet has had
that long without recording it, a running worker silent for 20 minutes. Each is told once
(`watch-manager.told`). A coordinator's watch prints its own silent workers, and each message to
one of its workers that the worker has not answered (no message of its own with that `re`) for
`FLEET_NUDGE_S`: `! worker a1 (notes-impl) has not answered #12 from user for 10 min: "<text, 120
chars>". Forward it (SendMessage a1).` (L1: workers read their inbox at checkpoints; only a message
left this long is forwarded). Each told once (`watch-coordinator.told`). `--once` exits after the first batch it prints.

`wait`: a closed decision prints `<ref> is already <status>: <answer or resolution>` and exits
0. An answer already given (a user message tagged with the decision, sent at or after its
`revised` or `opened` stamp, compared as instants, open-13) and not replied to by the fleet prints
at once. Otherwise it waits for the next such message, and reads the ledger again at every poll: a
decision closed meanwhile (withdrawn, or decided in the session) prints as a closed one does and
exits 0 (open-21, fixed).

**Listening** (`listening(DIR)`, the page and the warnings): `on` when the host's watch pid is
alive, or its `.left` is younger than 10 minutes, or the host sent a message in the last 10
minutes. `seen` is the host's cursor (0 without one). `unread` counts the user's messages after
`seen` that no one but the user has answered with `re` and that aren't tagged with a closed
decision (by id). `since` is the oldest one's `at`.

## fleets.py and the registry

`REGISTRY/<fleet>.json`, one per fleet being served:
`{id, role (coordinator|manager), dir, url, pid, session, since}`, written atomically (a `.tmp`
then a rename). `REGISTRY/gate/gate.json` is `{fleet, what, since}`. `REGISTRY/usage/reading.json`
holds the plan usage. Every read of the registry (`live()`) deletes the entry of a fleet whose
pid is dead or whose record is malformed. It also renames a fleet whose session got a custom title
(`<transcript>/custom-title.json`) to the title's slug, unless that is taken or reserved. Names:
the manager is `manager`; a coordinator is the slug of its session title, else of its project
(`[^A-Za-z0-9_.-]+` → `-`, trimmed, lower-cased), `-fleet` added to a reserved name, `-2`, `-3`
to a taken one. `user`, `coordinator` and `manager` are reserved.

| Command | Output | Exit |
| :-- | :-- | :-- |
| `list` | per live fleet: `<id>  <role>  session <session or (not named yet)>  <status>  <url>  <dir>`, then `now:`, `lanes in flight:`, `session last active`, silent workers, `chat: not read now…`, tokens, and each open decision `<ref> <id> [<kind>, for the user/manager(, blocks work)] <title>(  ANSWERED at HH:MM, not recorded)`; or `no fleet is being served on this machine` | 0 |
| `show FLEET` | now (with when it was said), chat, live workers with their last report (and `silent since HH:MM: check it before saying it runs` under a silent one), open decisions (and an answer not recorded), open roadblocks, the last 8 events | 1 unknown fleet |
| `manager` | `manager  session …  <url>  <dir>` and where `standing.md` is | 1 when none |
| `decision FLEET ID` | the decision in full; the page as `<url>#decision/<id>` | 1 unknown fleet or decision |
| `gate` | `free` or `held by <fleet> since <stamp>: <what>` (a hold by a fleet no longer served is forgotten) | 0 |
| `gate take FLEET WHAT` | `<fleet> holds the gate: <what>` | 1 held by another, or FLEET not served |
| `gate free FLEET` | `free` | 1 held by another |
| `name DIR SESSION` | `this fleet is <id>, the session <session>: use that one name everywhere`; renames the entry | 1 not served, reserved, or taken |
| `procs` | background processes each fleet's session started (by `/proc`, real time) | 0 |
| `whose FROM TO` | the files `jj diff --from FROM --to TO` moves, by owning fleet, from the manager's `DIR/owners` (`FLEET GLOB` per line, first match wins) | 1 no owners file, jj failed |
| anything else | usage | 1 |

## The other scripts

Stage 3 ported all of them but serve_dashboard.py, which [the hub](#the-hub-fleet-hub) replaces:
`fleet render`, `fleet served`, `fleet spend` and `fleet usage` do what the scripts below do, and
`fleet state` renders the page itself (no Python at run time). The page is in the oracle: the
`render-*` traces record `index.html` by its hash, so its bytes, `fleets.view()` included, are pinned
at every rendering step.

- **serve_dashboard.py** `DIR [--restart | --stop]`: serves DIR on a free port (the recorded one
  on restart) over `tailscale serve` (https), else plain http on the Tailscale IP with the chat
  read-only. `DIR/server.json` is `{pid, port, url, tls, post}` (`post`: `login:<tailnet login>`,
  or `closed`), and the worker logs to `DIR/server.log`. It registers the fleet, prints the URL,
  and in a coordinator's DIR prints how to reach the manager (`/f/<fleet>/` on the manager's
  address). Routes: `GET /chat?after=N`; `GET /events` (SSE: `hello {write, reason?, you?}`,
  `state` on connect and on change, `chat` with `id:`, `: ping` every 15 s; resumes from
  `Last-Event-ID` or `after`); `POST /chat` (201 with the message; 403 by the post policy or a
  cross-origin `Origin`, 415 not JSON, 413 over 16 KiB, 400 bad body or `ChatError`, 409 an answer
  to a closed decision, 400 a secret that reads as a value, 500 store failure); `POST
  /chat/preview` (who a text would reach; stores nothing); files under DIR with `Cache-Control:
  no-store`, `DIR/decisions/*` sandboxed by CSP; 421 on an unknown `Host`; on a manager's server
  `/f/<fleet>/…` proxied to that fleet's server. Pinned by test_chat, test_chat_serve and
  page.test.mjs.
- **render_dashboard.py** `STATE OUT [--fragment]`: validates, stamps `updated`, rewrites STATE,
  and writes the page: `assets/dashboard.html` with `/*__STATE__*/` replaced by `fleets.view(state)`
  (`<` escaped), as a full document or a bare fragment.
- **served.py**: every port `tailscale serve` exposes but the dashboards, with the process, its
  cwd and the fleet whose session started it (by its parents, else by the first transcript that
  wrote its address).
- **spend.py** `DIR`: `<output> tokens written and <input> read (<cached>% from the cache) in <n> answers`
  from the session transcript, or `no transcript for DIR: …`; exit 1 on bad usage.
- **usage.py** `capture [-- COMMAND...]` keeps a status line's `rate_limits` (a window's figure
  replaces the held one when it resets later, or resets at the same time with a higher percentage)
  in `REGISTRY/usage/reading.json`, then runs COMMAND on the same stdin and exits with its code
  (127 when it can't run). `show` prints each window.

## The hub (`fleet hub`)

One server per machine, always on (the `fleet-hub` systemd user unit), in place of a
serve_dashboard.py per fleet. A fleet appears on it when it is in the registry: `fleet serve DIR`
registers DIR (its entry lives while the Claude Code session that ran the command does: the nearest
`claude` among its parents, or `--pid`) and prints `http://<this machine>:<port>/f/<fleet>/`; a
fleet still served by serve_dashboard.py appears too, since the hub reads every fleet's files
itself. A manager made later appears the same way, on the same address.

- **Where it listens**: 127.0.0.1 and this machine's Tailscale IPv4, port `--port`, else
  `$FLEET_HUB_PORT`, else 7420; never 0.0.0.0. Without Tailscale (absent, stopped) it serves
  loopback alone and binds the tailnet address once Tailscale is up (checked every 30 s). A taken
  loopback port exits 1. `REGISTRY/hub/hub.json` holds `{pid, port, url, https, since}` while it
  runs. `--https PORT` also runs `tailscale serve --bg --https=PORT http://127.0.0.1:<port>` (and
  turns it off on exit): the page's browser alerts need a secure page.
- **Routes**: `GET /` the index (every fleet of this machine, then each peer hub's, with the plan's
  usage, the gate and what else the machine serves), `GET /events` its stream (`fleets` events, on
  change, `: ping` every 15 s), `GET /api/fleets` this machine's fleets (`{name, fleets: [summary
  without index, role]}`, what a peer hub reads). `/f/<fleet>/…` is serve_dashboard.py's routes for
  that fleet, same bodies and status codes: the page (rendered from `state.json` at each load, the
  file `index.html` when the state can't be read), `GET /chat?after=N`, `GET /events` (`hello`,
  `state` on connect and on change, `chat` with `id:`, pings; `Last-Event-ID` or `after`), `POST
  /chat` (201; 403 policy or cross-origin `Origin`; 415; 413 over 16 KiB; 400 bad body, `ChatError`,
  unknown decision or a secret's value; 409 an answer to a closed decision; 500 store failure),
  `POST /chat/preview`, the files under DIR (`Cache-Control: no-store`, `decisions/*` with the
  sandbox CSP; dot files and paths out of DIR 404). `/f/<fleet>` redirects (301) to `/f/<fleet>/`;
  `/f/<a>/f/<b>/…` is `/f/<b>/…`, so the manager's page, whose coordinators' links are relative,
  works under `/f/manager/`. 421 on a `Host` the hub doesn't answer to (loopback, `localhost`, the
  Tailscale IP, the MagicDNS name and short name, at its port; the https name with `--https`).
- **Live updates**: each stream looks at `state.json` and `chat.jsonl` every 300 ms (as
  serve_dashboard.py did); the view of a fleet is computed once for every client, again when the
  file changes or after 2 s (spend, liveness, links). The page already used SSE and polls
  `state.json` only when the stream fails, so it is unchanged.
- **Federation**: every 30 s the hub reads `tailscale status --json` and asks each online peer at
  `http://<its Tailscale IP>:<same port>/api/fleets` (2.5 s timeout). Peers that answer are listed on
  the index; a peer's fleet is `/f/<fleet>@<machine>/…` (the machine is the first label of its
  MagicDNS name; `@` is in no fleet id), passed through to the peer's `/f/<fleet>/…`, streams
  included. Only machines in the last tailscale status are reached, so the path names no arbitrary
  host. A post is checked by this hub's rules first, then by the peer's, which sees this machine.
- **Who may write (auth)**: the hub trusts the tailnet, not headers from the network. Tailscale
  already decides who reaches the Tailscale IP (the tailnet's ACLs) and encrypts the traffic; the
  hub asks `tailscale whois` who owns the machine a request comes from (cached 60 s), and only the
  login that owns this machine (`Self.UserID` in tailscale status) may post. A request on loopback
  comes from this machine and may post (any local process could write `chat.jsonl` itself); when it
  carries `Tailscale-User-Login` it came through `tailscale serve`, and that login is checked. Any
  other source address reads only. Why not `tailscale serve` with identity headers as the default:
  it needs the user to be Tailscale's operator and the tailnet's HTTPS certificates, it changes
  tailscaled's persistent config from a service, and a plain listener that took those headers on
  trust would let any tailnet peer claim any login; `whois` is tailscaled's own answer. The cost: the
  default address is plain http (inside WireGuard), where browsers withhold alerts; `--https` adds
  the https address when that matters. The stream's `hello` says `{write, reason?, you?}` from the
  same rule. A message's `author` is the login (the owner's, from loopback).

## Heartbeats

The per-tool-call heartbeat stays in the plugin's Python hook dispatcher (D13): `hooks/tstack-hook`'s
`fleet_heartbeat` runs on PostToolUse, PostToolUseFailure, SubagentStart and SubagentStop (registered
`async`, so no tool call waits on it) and, inside the synchronous dispatcher, on SessionStart and Stop.

- **Which fleet**: a session belongs to the fleet whose DIR is `$FLEET_DIR` when that is set and holds
  a `state.json`; else to each folder of its scratchpad (`scratchpad_dir` in the hook's input, Claude
  Code 2.1.257+) that holds a `state.json`. A coordinator's DIR is `<scratchpad>/coordinator`, and its
  subagents share its session and scratchpad, so every worker spawned as a subagent beats with no
  setup; a worker launched as its own process (`claude -p` in its workspace) gets `FLEET_DIR` (and
  `FLEET_WORKER`) from whoever launches it. Anything else is no fleet, and the handler does nothing.
  Why not the registry: it is machine-wide (one served fleet would make every session on the machine
  beat), it needs the fleet served first, and reading it means a file per fleet on every tool call;
  the scratchpad is the tie the fleet already uses (open-23) and costs one directory listing.
- **The file**: `DIR/heartbeats/<session>.json`, or `<session>.<agent_id>.json` for a subagent, replaced
  atomically (a dot-file then a rename): `{session, agent, agent_type, worker, cwd, workspace, path,
  tool, event, at, transcript, agent_transcript}`. `workspace` is the jj workspace's name, read from
  `.jj/working_copy/checkout` (no jj process); `path` is the tool's absolute `file_path`,
  `notebook_path` or `path`; `at` is a stamp from the fleet's clock (`FLEET_NOW`, local time with its
  offset). A start or a stop (no tool) keeps the `tool` the file already had. Measured: 0.35 ms median in process inside a fleet, under 0.5 ms outside one; the hook
  process itself is Python's start-up (~30 ms), off the tool call's path since it runs async.
- **Never breaks**: a failure is logged to the plugin's `hook.log`, and the hook exits 0 with nothing
  on stdout. It writes nothing to `state.json` or `chat.jsonl`, so no trace sees it.
- **Reading** (`src/heartbeat.ts`): each heartbeat is tied to a worker row by, in order, `worker`; the
  row whose `task_id` is the subagent's `agent`; the id the subagent's transcript gives it on its first
  line (`your id is X`, as before); the `workspaces[]` row whose name is `workspace` or whose path holds
  `cwd` or `path`; a workspace named after a worker. A worker's last-seen is its newest heartbeat, else
  (no heartbeat) its transcript's mtime. The page's view sets the worker's `active` from it, adds
  `beat: {tool, event}` when a heartbeat says it (the row reads "seen 3 min ago", its title the tool),
  and the silent rule (`SILENT_S`, twenty minutes) reads the same map: a running or blocked worker not
  seen for twenty minutes is silent on the page, in `fleets list`, the hub's index and the chat watches.
  Python's view still reads transcripts only; with no heartbeat both agree, which is every trace.

## Workspaces (`fleet ws`)

One jj workspace per worker that edits code; the coordinator's own (`default`) is the stack.

- `fleet ws DIR add NAME [-r BASE] [--agent ID] [--repo PATH]`: `jj workspace add <repo>-NAME -r
  <BASE's commit> --name NAME`, beside the default workspace of the repo `--repo` (else the cwd) is
  in. BASE defaults to `@-` there and must name one commit. Refused: an invalid name or `default`, a
  name the ledger or jj already has, an existing directory, no jj repo. Records `{id, agent (--agent,
  else NAME), path, repo, base, added, status: active}`, logs a note, renders the page, and prints the
  path and the line for the brief.
  A worker the ledger has no row for yet is warned about (`ws: no worker row a9 yet: record it ...`):
  a worker is recorded, then briefed and spawned.
- `fleet ws DIR list`: per active workspace, its worker and the worker's status and last-seen, then
  its `@` (empty, conflicted) and what it holds ahead of the stack, and the files those changes touch
  that are in none of the worker's lane entries (`outside its lane (src/): README: stop it ...`; an
  entry holds what it covers by the lane rule of [Warnings](#warnings) 6: a glob's `*` stays in its
  segment). Read with
  `--ignore-working-copy`: a worker's files are never snapshotted under it while it works.
- `fleet ws DIR prune [--apply | --dry-run]`: a workspace goes when (1) its worker's row is not
  running, queued or blocked (done, failed, stopped, or no row: gone); (2) its directory, if it is
  there, is the one jj knows as that workspace (`jj workspace root --name`) and its `.jj/repo` points
  at that repo's store; (3) after a snapshot of its files (a stale workspace is updated first: jj then
  keeps its unsnapshotted files in a copy of its change) nothing is ahead of the stack:
  `(::(NAME@ | change_id(<its change>)) ~ ::default@ ~ immutable()) ~ (empty() & description(exact:""))`
  is empty (integrated, abandoned, or empty). Going: `jj workspace forget NAME`, the directory deleted,
  the row `status: pruned` with `pruned`, an `integrated` event. Kept: `ws: kept NAME: <why>` on
  stderr, naming the changes not in the stack; exit 1 when any is kept. Only a recorded directory is
  ever deleted, so a workspace made by hand, or a recorded path that is something else now, is never
  touched. **The default is the dry run** (prints what would go and what stays): the delete reaches
  files jj never snapshots (ignored ones: `.env`, build output, a worker's notes), and a worker marked
  done too early loses its directory, so the delete takes a second, deliberate command, `--apply`.

## Rules as commands (`fleet brief`, `fleet turn`)

Rules the skills asked the model to remember, now kept by the CLI (stage 5; the inventory and each
rule's disposition are in [RULES.md](RULES.md)). Beside the refusals and warnings above:

- `fleet brief DIR WORKER` prints the part of a worker's brief the ledger holds: the line it opens with
  (`Read DIR/brief.md first; your id is a1.`), `Task:`, `Done when:` (the row's `brief`, a leading
  "done when" dropped), `Skill:` (a skill of this plugin whose SKILL.md says
  `disable-model-invocation: true` is read with the Read tool, by its path, since the Skill tool
  refuses it to a worker; any other is called with the Skill tool as `<plugin>:<skill>`; `none`
  prints no line), `Lane:`, `Workspace:` (the active `workspaces[]` row of the worker), `Step:` (the
  worker's current step) and `Chat:`. On stderr, for the coordinator: a missing completion criterion,
  a lane with no workspace, and the model to spawn it on with the `--task-id` to record after. A worker
  with no row is refused: it is recorded first. Matched by id, then by name.
- `fleet turn [DIR]` says whether the fleet holds the landing turn: the manager's `landings` step whose
  agent is the fleet's registry name is current. Exit 0 when it does, when no manager is served (the
  fleet lands on its own word), or, without DIR, when the session runs no served fleet; exit 1 (`turn:
  acme does not hold the landing turn (l1 (...) has it, infra's; yours, l2, waits in the queue). Ask the
  manager ...`) otherwise, or when DIR is not served while a manager is. Without DIR the fleet is the
  registry entry whose pid is among the command's parents (the session that serves it). The plugin's
  `land-check` runs it before its verdict: exit 1 makes the verdict `stop`, with the reason in `turn`.

## The advisor (`fleet advisor`)

One per fleet, started by the coordinator when workers need judgement (D13 stage 6): the plugin's
`advisor` agent (`agents/advisor.md`, `tstack:advisor`), on Fable, read-only, long-lived. Workers and the
coordinator ask it through `SendMessage` before a question goes to the user; it rules from the ledger's
decisions, its earlier answers, the repo (`CONTEXT.md`, ADRs, `jj log`), `memo recall` and the
principles, or says the question is the user's, and the asker then opens a decision with its
recommendation attached.

`fleet advisor DIR [--model fable|opus] [--task-id ID] [--log TEXT]` (TypeScript only; it writes through
`fleet state`, so the coordinator, the ledger's one writer, runs it):

- **The row.** The worker row `advisor`: task `Answers the fleet's judgement questions before they
  reach the user`, skill none, no lane, model fable (or the row's, or `--model`), status **queued**. New:
  in the milestone of the current step, else the first; logs `Advisor started on <model>.` (or
  `--log`). Known: model, status, `--task-id` and `--log` as given. An empty roadmap is refused, and so
  is a model other than fable or opus (`advisor: the advisor runs on fable, or on opus when Fable is
  unavailable; not 'sonnet'`).
- **Why queued.** The advisor waits between questions; a `running` row with no tool call for twenty
  minutes is a silent worker on the page, in `fleets show` and the watches. `queued` is live (the page
  lists it, `set --status done` names it, `park` stops it) and is never silent.
- **Why a row.** It puts `advisor` on the chat roster (`say --as advisor`, `@advisor`), and its model
  and tokens on the page (`--task-id` measures them from its transcript).
- **Output.** Without `--task-id`: the advisor's prompt on stdout (its DIR, the CLI's path, where the
  ledger, the brief and the chat are, the line that records an answer, its model), and on stderr how to
  spawn it (`subagent_type "tstack:advisor"`, `model`, in the background) and how to restart it on Opus.
  With `--task-id`: `advisor recorded on <model> as <ID>`, and on stderr the line for "This fleet" in
  `brief.md` that tells workers to `SendMessage <ID>` before asking the user.
- **Fable unavailable.** Claude Code has no fallback for a subagent's model on limits, credits or
  access (`--fallback-model` covers the main loop's overload only). The Agent call's `model` overrides
  the agent's frontmatter, so the coordinator reads the failed spawn (an error naming the model, a
  usage or credit limit, no access), runs `fleet advisor DIR --model opus --log "Fable unavailable:
  <the error>"`, spawns again with `model: "opus"`, and says so in its next message.
- **Each answer is recorded on the chat**, not the ledger: `fleet chat DIR say --as advisor "<asker>
  asked: <question> | <verdict> | <reason> | <confidence>"`. The page shows both; the chat is the store
  a participant other than the coordinator may append to (under its lock, while `state.json` has one
  writer and no lock), the message reaches the user, who can overrule it with a reply, and it
  survives a restart: the new advisor reads `chat log` for its earlier rulings. The asker is named
  without `@`, so the record is not opened in the asker's inbox.

## Files by writer

| Writer | Files |
| :-- | :-- |
| every `state.py` command | mkdir DIR |
| a `state.py` write | `DIR/state.json` (twice when rendering), `DIR/brief.md` and (manager) `DIR/standing.md` when missing, `DIR/index.html` unless `--no-render` |
| `decision --body` / `--no-body` | `DIR/decisions/<id>.html` written / deleted |
| `chat say` | `DIR/chat.jsonl` (created on first message) |
| `chat watch` | `DIR/watch-WHO.pid`, `.cursor`, `.left`, `watch-coordinator.told`, `watch-manager.told` |
| any reader of the registry (`fleets.py`, a manager's `chat.py`/`state.py`, the render) | deletes dead `REGISTRY/*.json`, renames entries after a session title |
| `fleets.py gate take/free`, `name` | `REGISTRY/gate/gate.json`, `REGISTRY/<fleet>.json` |
| `serve_dashboard.py` | `DIR/server.json`, `DIR/server.log`, `REGISTRY/<fleet>.json` |
| `fleet serve` | `REGISTRY/<fleet>.json` (removed with `--stop`) |
| `fleet hub` | `REGISTRY/hub/hub.json` while it runs; `DIR/chat.jsonl` on a post |
| `usage.py capture` | `REGISTRY/usage/reading.json` |
| the plugin's hook (`fleet_heartbeat`) | `DIR/heartbeats/<session>[.<agent>].json` |
| `fleet ws add` / `prune --apply` | `DIR/state.json` (`workspaces`, `events`, `updated`), `DIR/index.html`; the workspace directory made / deleted |

## Oracle traces

`fleet/oracle/run.py` (stdlib) replays a trace against an implementation. A trace is JSON lines:
a header, then one step per line.

```jsonl
{"trace": 1, "name": "ledger-lifecycle", "about": "what it shows"}
{"cli": "state", "argv": ["$DIR", "init", "--project", "p", "--goal", "g", "--no-render"], "clock": "2026-01-05T09:00:00+00:00"}
{"cli": "state", "argv": ["$DIR", "milestone", "m1", "--title", "M", "--no-render"]}
{"fixture": "append", "path": "$DIR/chat.jsonl", "content": {"id": 1, "at": "2026-01-05T09:05:00+00:00", "from": "user", "to": ["coordinator"], "text": "hi", "re": null}}
{"cli": "chat", "argv": ["$DIR", "inbox", "--as", "coordinator"], "clock": "2026-01-05T09:06:00+00:00"}
{"cli": "fleets", "argv": ["gate"], "env": {"FLEET_CHECK_S": "1"}, "timeout": 5}
```

- `cli`: `state`, `chat` or `fleets`; `argv` after the program; `clock` (optional) sets the
  virtual clock from this step on (passed as `FLEET_NOW`; the first is `2026-01-05T09:00:00+00:00`);
  `env` overrides (null unsets); `stdin`; `timeout` (default 20 s, result `"timeout"`).
- `fixture`: `write`, `append` (content a string, or an object written as one JSON line),
  `patch` (`set` and `unset` top-level keys of a JSON file) or `delete`, at `path`.
- Tokens, in argv, env, content and paths: `$W` the work root (the cwd), `$DIR` = `$W/coordinator`,
  `$REGISTRY` (`FLEET_HOME`), `$PID` the runner's own pid (a registry entry that reads as alive).
- Environment of every step: `TZ=UTC`, `LANG=C.UTF-8`, a throwaway `HOME`, `CLAUDE_CONFIG_DIR`
  and `XDG_STATE_HOME`, `FLEET_DISCOVER=0`, `FLEET_HOME=$REGISTRY`.

A result file has a header line (`{"results": NAME, "trace": 1}`), then one line per step:

```json
{"step": 9, "exit": 0, "stdout": "state.json updated (decision D1)\n", "stderr": "",
 "changed": {"$DIR/state.json": {"project": "acme-billing", "...": "..."}}, "removed": ["$DIR/decisions/d4.html"]}
```

`changed` holds every file under `$W` and `$REGISTRY` the step added or changed: `.json` parsed,
`.jsonl` as a list of parsed lines (`{"raw": …}` for one that doesn't parse, `{"torn": true}` last
when the file doesn't end in a newline), `index.html` as `{"sha256": …}` of its text with the
session's paths as tokens (so the page is compared byte for byte), other text as text,
binary as `{"sha256": …}`. `*.pid`, `*.tmp`, `server.log` and `__pycache__` are ignored. In every
string, the session's paths read back as `$DIR`, `$W`, `$REGISTRY`, `$USERHOME`, `$TMP`, the fleet
CLI's path (`<repo>/fleet/bin/fleet`, which both implementations print) as `$FLEET`, and the
implementation's own directory as `$SKILL` (`--subst PATH=TOKEN`); a `pid` equal to the runner's
reads `$PID`. With the clock pinned, timestamps are deterministic and are compared as they are.

```
run.py run TRACE [--impl CLI=COMMAND]... [--subst PATH=TOKEN]... [-o OUT]
run.py check TRACE [EXPECTED] [--impl ...]      exit 1 at the first divergence, printed with the steps before it
run.py diff A B                                 two result files
run.py record TRACE...                          TRACE's .expected.jsonl, from the Python oracle
```

Stage 2 runs `run.py check` on each trace in `oracle/traces/` with
`--impl state="fleet state" --impl chat="fleet chat" --impl fleets="fleet fleets" --subst <its dir>='$SKILL'`,
or sets `FLEET_ORACLE_IMPL='{"state": "fleet state", "chat": "fleet chat", "fleets": "fleet fleets", "subst": {"<its dir>": "$SKILL"}}'`
for `test_corpus.py` and `test_model.py`. The corpus: `ledger-lifecycle`, `decisions`,
`plan-and-grill`, `chat`, `manager` (written by hand from the tests), `emptied` (open-7),
`model-seed-1`, `model-seed-2` (random sequences), and the page's: `render-<name>` for each
hand-written trace, the same steps with every state command rendering, plus `render-page` (a
session's scratchpad with its transcript, links, markup and U+2028 in the text, unread chat, a
manager with a coordinator's summary, the plan's usage and the gate). Where a behaviour marked open changes on purpose, re-record
the trace with the Python oracle and edit the expected lines by hand, or record them from the
new implementation once it's the reference. Either way, review the diff.

## The model-based test

`oracle/test_model.py` drives 25 random sequences of 60 steps (a fresh seed each run;
`FLEET_MODEL_SEED`, `FLEET_MODEL_SEQS`, `FLEET_MODEL_STEPS`) through state.py and chat.py, with a
model: milestones and their step order, workers (status, milestone, rounds, name, tokens),
decisions (kind, status, number, place, options, recommendation), roadblocks, kept notes, links,
the event count, and the chat's messages. The clock moves 0-25 minutes per step. Checked after
every step:

- the exit code the model predicts (0, 1, 2), with no traceback;
- a refused command changed neither `state.json` nor `chat.jsonl`;
- the ledger's shape equals the model's (the fields above, the step order, the event count);
- stderr is exactly the warnings the model expects: the stale Now line with its age in minutes,
  live rows in a paused or done fleet, a chat nobody reads (computed on the ledger before the
  command), a Now line naming a closed decision, an answer on the page not recorded, decisions left
  open by `set --status done`; on a validation refusal, those plus the reason, and nothing on stdout;
- `show`'s first line, milestone lines, worker lines, decision lines and event count, against
  `state.json`;
- `inbox`'s messages against the model's open messages; `chat.jsonl` against the model's;
- with no model: events and chat are append-only; a number once given never changes; a closed
  decision never changes but for its step and milestone; decisions go only from open to decided or
  withdrawn; agents name known milestones and steps name known workers; numbers are unique;
  `updated` is the step's clock; `step next` and a new worker print what the model expects.

It killed six hand-made mutants (step placement, rounds, the stale boundary, park's statuses,
double unblocking, self-addressing). A failure prints the seed, the command, and a trace to replay
with `run.py`.

## Open

Found by the model test or the traces, or read in the code without a test pinning it. Each one
says what happens now. Fixed in this stage: a decision's number given to `roadblock --decision`,
`link --decision` or `--supersedes` is now kept as its id (it was stored verbatim: the first two
were refused after printing success, the link never tied to its decision), and `fleets.py
decision FLEET A1` prints the id's page address (it printed `#decision/A1`, which the page
doesn't find). And the refusal of a name two workers share names the id before the name: it
iterated a set, so which label it named changed with the hash seed (found by the differential test).

Stage 2's TypeScript fleet (`fleet/`, `fleet state|chat|fleets`) does what Python does for every item
below, open-1 fixed in both; argparse's usage and error texts (exit 2) match too, wrapped to
`COLUMNS`. Where it keeps a behaviour on purpose for the migration, the item says *Stage 2*.

1. **Fixed: a decision whose id reads as a later number blocked every decision of that letter.**
   Opening `D4` as an input (numbered I2) was accepted; the next choice would have been numbered
   D4, which validation refused, naming the old decision, and so was every choice after it.
   Numbering now skips a number another row of the same list has as its id (D5 there), for
   decisions, links and roadblocks alike; validation still refuses a new decision whose id is a
   number already given. Trace: `decisions.jsonl` steps 31-33. The model follows it.
2. **Fixed (stage 5, both): a refused write had already printed its success text.** What a handler
   says is held until the ledger is checked and written; a refusal prints only the warnings and its
   reason. The model checks that a refused state command prints nothing on stdout.
3. **Fixed (stage 5, both): `roadblock --agent` wasn't checked.** It is now, as every other
   `--agent` is; and `--needs user` requires a decision on update too (L8, 2026-10-01).
4. **Resolving a resolved roadblock** logs `resolved` again and sends its worker, if blocked for
   another reason, back to running.
5. **Fixed (stage 5, both): `park` left the parked workers' steps current.** They go back to
   pending and keep their agent.
6. **`step --remove` leaves a decision's `step` dangling**: it still names the removed step, and
   validation doesn't check a decision's step or milestone.
7. **A known decision takes any `--kind`**, a grilling included (`decision g1 --kind input`
   turns a grilling into an input and keeps its questions), and a kind change keeps the number
   of the old letter.
   *Stage 3*: an emptied field (`decision --title ""`, `--question ""`, `link --url ""`,
   `--title ""`) was written by the TypeScript fleet as the string `"None"`; it is JSON null now,
   as Python's `or None` writes it, and prints as `None` where Python prints it (the change event,
   `show`, a closed decision's refusal, `fleets decision`). A ledger Python wrote with such a null
   reads in TypeScript (it was refused). `--kind ""` is refused by its choices in both. Trace:
   `emptied.jsonl`.
8. **`chat say --decision X` is stored unchecked**: a number or an unknown id is kept as given,
   and the page, `wait` and `listening` match decisions by id.
9. **Fixed: the page's payload wasn't in the oracle.** `index.html` is recorded by its hash now,
   and the `render-*` traces render at every step, so `fleets.view()` (spent, links up or down,
   the manager's coordinators and usage, the gate) is compared byte for byte. The TypeScript
   `state` renders the page itself (stage 3). Left out: a figure read from a file time (a worker's
   or a session's `active`, silent workers) and the machine's served ports, which no trace can
   pin; test/page.test.ts covers them. A float with no fraction (`61.0`) in a hand-written
   `reading.json` prints as `61` in TypeScript, where Python keeps `61.0` (JavaScript reads both as
   one number; the status line, being JSON from JavaScript, never writes `61.0`).
10. **`show` never renders** and ignores `--no-render`/`-q`, though state.py's docstring says
    every command stamps, validates and renders.
11. **`--no-render` and `-q` are stripped anywhere in argv**, values included: `event -q` records
    nothing (argparse then misses TEXT), and a note can't say `-q`.
12. **Fixed (the cutover, both): printed commands named the Python scripts.** Every command either
    implementation prints names the fleet CLI: `fleet state <dir> …`, `fleet chat …`, `fleet fleets …`,
    `fleet usage capture`, and argparse's usage says `fleet state` and `fleet chat`. The ones meant to
    be run as printed (the `wait` hint, brief.md's chat lines, from its `{fleet}` placeholder) give its
    full path, `<plugin>/fleet/bin/fleet`. The traces were re-recorded from Python: only stdout,
    stderr, `brief.md` and the page's hash changed.
13. **Fixed (stage 5, both): stamps were compared as strings.** `wait`, the answered-at check and
    numbering by `opened` compare instants now (`clock.at_or_after` / `atOrAfter`, `clock.order` /
    `byInstant`); a stamp that does not parse falls back to its text. The page's own script still
    compares what it compares.
14. **Liveness reads processes and file times**: watch pid files (`os.kill(pid, 0)`), `.left`
    mtime, transcript mtimes (silent workers, session activity). The oracle doesn't exercise them
    (no watch runs across steps, no transcripts). A watch dates `.left` by the clock seam.
15. **`state.json` is written in place, not atomically**, and twice per rendered command; readers
    (the server, a manager) tolerate a half-written file by skipping it. Stage 2: write once,
    atomically.
    *Stage 2*: kept (one write with `--no-render`, the renderer's second otherwise).
16. **A validation refusal can only name the first fault.**
17. **Every `state.py` command creates DIR**, even one refused for want of a ledger.
18. **`closed_named` matches L and R numbers** but looks them up among decisions only (a
    harmless miss).
19. **`roadblock --decision` on an update must name an open decision** even when it's the one
    already stored, so `roadblock r1 --resolved --decision d1` after d1 closed is refused.
20. **A manager's ledger accepts any name as a worker** (`known()`), so a typo in `--agent` is
    stored.
21. **Fixed (stage 5, both): `chat wait` never returned for a decision closed without an answer.**
    It reads the ledger at every poll and ends as it does for one closed before it started.
22. **`step next` takes its letters from the milestone's last lettered step**, so a milestone
    with mixed prefixes switches letters with its last step.
23. **Worker figures come from transcripts found by path shape** (`…/<project>/<session>/scratchpad/<name>`)
    and the `your id is X` / `You are X` regex. *Stage 4*: a worker's heartbeat is read first
    ([Heartbeats](#heartbeats)); the transcript stands in for a worker with none, and still gives
    the tokens and duration.
24. **`agent --step S` with a status that doesn't map** (queued, failed, stopped) points S at the
    worker and leaves S's status alone.
25. **Registry reads delete and rename entries**: `fleets.py list` or a manager's `state.py set
    --now` can change `REGISTRY` as a side effect.
