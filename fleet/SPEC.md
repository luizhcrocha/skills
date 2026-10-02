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
[Listening hooks](#listening-hooks) ·
[Workspaces](#workspaces-fleet-ws) · [The preview](#the-preview-fleet-preview) · [The advisor](#the-advisor-fleet-advisor) · [Files by writer](#files-by-writer) ·
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
| `FLEET_WORKER` | the plugin's hook | the worker id such a process is; written into its heartbeat. A session with it is a worker: the listening hooks leave it alone |
| `FLEET_PREVIEW_S` | `fleet preview`'s updater | how often it looks at the workers' working copies (default 3 s) |
| `FLEET_PREVIEW_WAIT_S` | `fleet preview start` | how long it waits for a dev server to answer before saying it does not yet (default 30 s) |
| `FLEET_NUDGE_MIN` | the plugin's hook (`fleet_chat_nudge`) | how long the user's message waits unread, or an answer unrecorded, before the session is told mid-turn (default 3 minutes). See [Listening hooks](#listening-hooks) |

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

**set** `[--status running|paused|blocked|done] [--now TEXT] [--goal G] [--workspaces isolated|shared]`: sets what is given.
`--now` stamps `now_at`, even with the same words, and warns about each decision the text
[names by number](#warnings) that is closed. `--workspaces` writes `workspace_mode`: `isolated` (a jj
workspace per worker that edits code; the default, also when the key is absent) or `shared` (the workers
share one working copy, the repo's default workspace; see [Workspaces](#workspaces-fleet-ws)).

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
- **Lanes that meet in a shared working copy are refused.** In a fleet with `workspace_mode: "shared"`, an
  `agent` command that gives `--lane`, `--task` or `--status running` and leaves its row running is refused
  when its lane meets a running or blocked worker's (the rule of [Warnings](#warnings) 6, L7): `state: a2's
  lane overlaps a1's (running: src/x.ts), and this fleet's workers share one working copy (\`set --workspaces
  shared\`), where two workers on the same files overwrite each other: record it \`--status queued\` until
  that worker is done, or give the task to that worker.` Checked last, after the step and the log; a
  blocked worker counts, since its edits are still in the copy. An isolated fleet warns instead.
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

**decision** `ID [--kind decision|input|secret|action --title T --question Q --why W] [--blocking | --not-blocking] [--option "KEY: label | consequence"]... [--same-options] [--recommend R --reason WHY] [--secret NAME] [--manual TEXT] [--body FILE | --no-body] [--agent A] [--supersedes ID] [--step S] [--milestone M] [--log TEXT] [--asks user|manager] [--decide ANSWER --resolution HOW | --withdraw REASON | --hold REASON | --unhold]`

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
     `--manual`; **action** `--manual`, and no options or `--recommend` (a yes or no on what the fleet would do is a decision); **input** nothing more. Kind **grill** is refused here
     (it is opened with `grill`). A secret's or action's `--manual` with more than one non-empty line
     and no ```` ``` ```` in it is refused, new or changed: ``--manual has N lines and no fence: put the
     commands in a fenced block (a line ```nu, the commands, a line ```), any prose outside it``. One
     bare line is taken as it is, and a manual already stored is not checked again when another
     field changes. An option is `KEY: label | consequence` with a key matching the
     id pattern; keys are unique. **permission** (TypeScript only: see [Permission
     grants](#permission-grants)) takes the refused call instead of options.
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
   manager's decision on, else `<title> changed: <--log, or the changed fields>`. A revision
   that gives `--question`, `--option` or `--manual` re-presents the item: it clears a hold.
   **Hold** (`--hold REASON`, `--unhold`; one of `--decide`/`--withdraw`/`--hold`/`--unhold`,
   else exit 2): the user answered and the fleet must act before the item can proceed. Only on a
   known decision (`unknown decision 'X'`); a closed one refuses as in 3. `--hold` with a blank
   REASON is refused (`--hold says what the fleet does first, before the item comes back to the
   user`); `--unhold` on one not held is refused (`<title> is not held: --unhold takes back a
   --hold`). Applied after the revision above: `--hold` sets `held` = REASON and `held_at` = now
   (again on a held one: both replaced) and logs a `note`, `<title> held by the fleet: <reason>`,
   not important, tagged with the decision; `--unhold` removes both keys and logs `<title> no
   longer held by the fleet`. A held decision counts as recorded: every answer given until
   `held_at` is the fleet's ([warning 4](#warnings), `chat wait`, `fleets`, the page's Stuck).
   `show` reads `OPEN, held by the fleet (<reason>)`.
6. `--decide ANSWER --resolution HOW` closes it decided: logs `decision`
   (`<title>: <answer> (<resolution>)`). `--withdraw REASON` closes it withdrawn: logs `resolved`
   (`<title> withdrawn: <reason>`). Either sets `closed` = now, removes a hold, and resolves every
   open roadblock waiting on it (each logging its own `resolved`, and unblocking its worker).
7. Validation: ids unique; no id equal to another decision's number; `supersedes` and
   roadblocks' `decision` name existing ids; defaults are filled (`asks` user, `blocking` false,
   `page` true, `body` false, the optional fields null, a grilling's `questions` []). `held` and
   `held_at` are present only on a held decision, both strings (`decision X is held without its
   reason and when (held, held_at)`), and only on an open one (`decision X is <status> and still
   held`); no default fills them.

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
  `revised`, and new questions or revisions clear a hold. The first round prints the `wait` line.
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
`<project> [<status>(, manager)(, shared working copy)] <now>`; per milestone `  <id> <title> (<done>/<steps>)` and
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
               (open|answered|dropped), answer, asked, answered?, dropped?}),
               held?, held_at? (the fleet works on the answer first; removed when re-presented or closed),
               refusal? (permission, TypeScript only: {tool, call, rule, cause, root, agent_id})}
events[]      {at, agent|null, kind, text, important?: true, decision?}   append-only
links[]?      {id, ref, url, title, kind (dev|page), decision, agent, note, since}
kept[]?       {id, text, at}
workspace_mode? "isolated" | "shared"   `set --workspaces`; absent reads as isolated
workspaces[]? {id (the jj workspace's name), agent (its worker now), path, repo (the default workspace's root),
               base (change id), added, status (active|pruned), pruned?,
               handovers[]? {from (the worker that held it before), at}}   written by `fleet ws` only
```

**Text on the page.** The page shows a decision's `question`, `why`, `reason`, its options'
`consequence`, `manual`, a grilling question's `body`, a roadblock's `detail` and a chat message's
`text` in one small format: paragraphs split on a blank line, inline code in backticks, and fenced
blocks (a line of three or more backticks with an optional language tag, `nu`, `sh`, `ts`, `json`,
`toml`, `nix`, `python`, `sql`, `rust`, `diff`, `yaml` and their aliases), shown highlighted with a
copy button. Nothing else is markup and no HTML is rendered. Text with no backtick shows as it always
did. A `manual` with no backtick whose every non-empty line is a command, not a sentence (it does not
end in `.`, `!`, `?` or `:`, and does not open with a capitalised word and a space), shows as one `nu`
block; one with prose among its lines shows as it always did. The CLIs store
the text as given; the format is the page's (`fleet/page/src/text.ts`).

`workspaces` is a key neither state.py nor `fleet state` knows: both keep it as it is (Python
round-trips the whole object, TypeScript keeps a ledger's unknown keys in place), and the page's view
passes it through. No oracle trace has it. `workspace_mode` is both implementations' (`set
--workspaces`, the refusal above, `show`, validation), pinned by the `workspaces` trace and the model.

Validation (step 8, every write) requires `project, goal, status, now, started` as strings and
`roadmap, agents, roadblocks, events` as lists, the statuses above, `workspace_mode`, when present,
`isolated` or `shared` (`render_dashboard: workspace_mode 'both' not in ['isolated', 'shared']`), the agent, step, roadblock and
event keys listed, and the decision rules above. It fills the defaults it checks (agents' tokens,
duration_ms, skill, model, brief, report, rounds; decisions' optional fields), so a hand-written or
older ledger comes out complete after one command.

## Numbers (refs)

On every write, each decision, link and roadblock without a `ref` is given one: a letter for its
kind (decision **D**, action **A**, input **I**, secret **S**, grill **G**, permission **P**
(TypeScript only), link **L**, roadblock **R**), and 1 + the highest number of that letter already given, skipping a number that another row of
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
   leaves whose answer the user gave on the page after it was opened or last revised (instants), and
   after `held_at` when it is held, with no reply from anyone but the user. Not for `init`.
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
   Decided on the product of the two globs' automata (`lanes.py`, `fleet/src/ledger/lanes.ts`). In a
   fleet whose workers share one working copy the same meeting is refused instead (`agent`, above).
7. **A model outside the policy** (`state: a1 is recorded on haiku, outside the model policy (opus,
   sonnet, fable): spawning it on haiku needs the user's OK.`) on an `agent` command that gives such
   a `--model` (L3).
8. *TypeScript only* (Python's ledger has no `workspaces`, and no trace does): **a done worker's
   workspace not pruned** (`state: a1's workspace a1 still there though its worker is done: bring its
   changes into the stack, then prune it (\`fleet ws <dir> prune\`, a dry run, then --apply), or hand it
   to the next worker of its lane (\`fleet ws <dir> add <next> --reuse a1\`).`), naming both ways out, on every command,
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
message that opened a side chat), and, written by the hub only (its Delivery, in [The hub](#the-hub-fleet-hub)),
`delivered [{fleet, id}]` (on the manager's message: the coordinators that have it in their own chat, and
its id there) and `via {fleet, id}` (on that copy, `{fleet: "manager", id}`, and on a coordinator's answer
mirrored onto the manager's page, `{fleet, id}` of the answer). `parts` split the text into plain parts and mentions
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
| `watch --as WHO [--after N \| --resume] [--all] [--once] [--fleets [--batch SECONDS]]` | prints what is open for WHO with id > N (with `--all`, every open message from the user too), then each new message to WHO (or from the user) as it lands; with `--fleets` (the manager's) also what the user does on the other fleets' pages | one line each | 0 on SIGTERM or `--once`; 1 `--fleets` not as the manager |
| `wait DECISION...` | waits for the user's answer to one of these open decisions | the answer's line, then `-> the user answered <ref>: record it first, ...` | 1 unknown decision |

A printed line: `#<id> <from>( (<name or author>)) -> <to, each with its name>( [<ref> <decision>])( [side chat #N])( [delivered to <fleet> #<id>, ...])( [via <fleet> #<id>])( (quoting <from>: "<quote>"))`
`: <text>( [re #N])`. Line breaks print as ` ⏎ `, a tab as a space, and other control characters
are dropped, so a message is always one line.

`watch`: `DIR/watch-WHO.pid` holds its pid while it runs (removed at exit if still its own),
`watch-WHO.cursor` the last id printed (`--resume` starts after it), and `watch-WHO.left` is
touched when it ends. With `--all`, a message from the user is left out for each recipient that has it in
its own chat (`delivered`): a manager's watch does not print the user's message to coordinators the hub
delivered it to, and prints, with its `[delivered to ...]` mark, one that also names the manager or a
coordinator it was not delivered to. A manager's watch prints `!` lines every `FLEET_CHECK_S`: a fleet that
doesn't read its chat while the user waits more than `FLEET_UNHEARD_S`, an answer a fleet has had
that long without recording it, a running worker silent for 20 minutes. Each is told once
(`watch-manager.told`). A coordinator's watch prints its own silent workers, and each message to
one of its workers that the worker has not answered (no message of its own with that `re`) for
`FLEET_NUDGE_S`: `! worker a1 (notes-impl) has not answered #12 from user for 10 min: "<text, 120
chars>". Forward it (SendMessage a1).` (L1: workers read their inbox at checkpoints; only a message
left this long is forwarded). Each told once (`watch-coordinator.told`). `--once` exits after the first batch it prints.

**The other fleets' news** (`watch --as manager --fleets`, M20): the manager's watch also reads every
served fleet's `chat.jsonl` and `state.json` (the manager's own DIR and any `manager` entry left out) and
prints one line per event, fleet by fleet in registry order, its messages before its decisions:

- a message from the user on that fleet's page: `<fleet>: you answered <ref> <title>: <first line>` when
  it carries a decision (looked up by id, then by number; an unknown one prints as given), else
  `<fleet>: you wrote to <to, joined by ", ">: <first line>`;
- a decision of that fleet that now stands somewhere new: opened for the user (new with `asks` user,
  passed on with `--asks user`, or back from held) `<fleet> <ref> opened for you: <title>( (blocks work))`;
  `<fleet> <ref> decided: <title>: <first line of the answer, else the resolution>`;
  `<fleet> <ref> withdrawn: <title>: <first line of the reason>`; held (open, with a non-empty `held`)
  `<fleet> <ref> held: <title>(: <first line of held, when it is text>)`. A decision opened for the
  manager is not news (the coordinator writes to the manager's session).

Nothing else of a fleet is (no worker's message, no reply of its coordinator, no message the hub delivered
from the manager's page: `via` the manager). A *first line* is the
text's first line that has text, one-lined as a message is, spaces trimmed, cut at 200 characters, with
` …` when the text goes on. Where each decision stands is `open:<asks>`, `held` or its status; a decision
is news when that changes. The cursors are per fleet, by its directory (a renamed fleet keeps them), in
`DIR/watch-manager.fleets.json`: `[{fleet, dir, chat (the last message id read), decisions {id: where it
stands}}]`. A fleet seen for the first time is read from then on, printing nothing; `--resume` takes up
the cursors the last watch left, so a fleet's news is printed once, whenever the watch runs. The
manager's own chat is printed as before and never again as a fleet's.

`--once` with `--fleets`: a message to the manager (and a `!` line) still ends the watch at once; the
first news of the other fleets opens a window of `--batch` seconds (120 by default, an int), and the
watch prints all that lands in it, then exits, so one wake covers a burst of the user's actions. The
window runs on the machine's monotonic clock, as `FLEET_CHECK_S` does: a pinned `FLEET_NOW` dates what
the watch measures, not its pace. `--batch 0` exits with the first batch (the traces).

`wait`: a closed decision prints `<ref> is already <status>: <answer or resolution>` and exits
0. An answer already given (a user message tagged with the decision, sent at or after its
`revised` or `opened` stamp, compared as instants, open-13, and after `held_at` on a held one) and
not replied to by the fleet prints at once. Otherwise it waits for the next such message, and reads the ledger again at every poll: a
decision closed meanwhile (withdrawn, or decided in the session) prints as a closed one does and
exits 0 (open-21, fixed).

**Listening** (`listening(DIR)`, the page and the warnings): `on` when the host's watch pid is
alive, or its `.left` is younger than 10 minutes, or the host sent a message in the last 10
minutes. `seen` is the host's cursor (0 without one). `unread` counts the user's messages after
`seen` that no one but the user has answered with `re`, that aren't tagged with a closed
decision (by id), and that some recipient has only here (not every one of them in `delivered`). `since` is the oldest one's `at`.

## fleets.py and the registry

`REGISTRY/<fleet>.json`, one per fleet being served:
`{id, role (coordinator|manager), dir, url, pid, session, since}`, written atomically (a `.tmp`
then a rename). `REGISTRY/gate/gate.json` is `{fleet, what, since}`. `REGISTRY/usage/reading.json`
holds the plan usage per account, `{"accounts": {KEY: {email, seen, five_hour?, seven_day?}}}` (see usage.py). Every read of the registry (`live()`) deletes the entry of a fleet whose
pid is dead or whose record is malformed. It also renames a fleet whose session got a custom title
(`<transcript>/custom-title.json`) to the title's slug, unless that is taken or reserved. Names:
the manager is `manager`; a coordinator is the slug of its session title, else of its project
(`[^A-Za-z0-9_.-]+` → `-`, trimmed, lower-cased), `-fleet` added to a reserved name, `-2`, `-3`
to a taken one. `user`, `coordinator` and `manager` are reserved.

A fleet's **summary** (`summary(entry)`: each of the manager's page's `coordinators[]`, and `/api/fleets`
without `index`) is `{id, url, session, dir, name, project, goal, status, now, updated, workers, tokens,
spent, chat, active, now_at, lanes, roadblocks, index, silent, decisions}`. `decisions` holds each open
decision with a string id: `{id, ref, kind, title, question, why, blocking, asks, opened, revised,
answered, said, questions?, held?, held_at?}`. `answered` is when the user's answer was sent and not
recorded (`answered_at`, as `wait` reads it). `said` is the fleet's chat about it: the user's messages
tagged with it and the replies to them (a message not from the user whose `re` names one), each
`{id, at, from, to, text, re, decision}`, oldest first. `questions`, on a grilling only, is its open
questions as `{id, of, status, asked}`. With `said` and `questions` the manager's page decides whether
a fleet's item waits on the user by the fleet's own page's rule (`awaiting` in `page/src/core.ts`), on
the inputs that page has; `held` and `held_at` are there only on a held decision.

| Command | Output | Exit |
| :-- | :-- | :-- |
| `waiting` | what waits on the user, from every live fleet's ledger, the manager's included: per open decision that asks the user and is not held, `<fleet> <ref> [<kind>(, blocks work)] <title>  since <revised or opened, YYYY-MM-DD HH:MM>`, then `  ANSWERED at HH:MM (#N): <first line>; not recorded yet` when the user's answer waits unrecorded; `nothing waits on the user`, or `no fleet is being served on this machine` | 0 |
| `list` | per live fleet: `<id>  <role>  session <session or (not named yet)>  <status>  <url>  <dir>`, then `now:`, `lanes in flight:`, `session last active`, silent workers, `chat: not read now…`, tokens, and each open decision `<ref> <id> [<kind>, for the user/manager(, blocks work)] <title>(  ANSWERED at HH:MM, not recorded)(  held by the fleet: <reason>)`; or `no fleet is being served on this machine` | 0 |
| `show FLEET` | now (with when it was said), chat, live workers with their last report (and `silent since HH:MM: check it before saying it runs` under a silent one), open decisions (and `held by the fleet since HH:MM: <reason>`, and an answer not recorded), open roadblocks, the last 8 events | 1 unknown fleet |
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
  address). Routes: `GET /chat?after=N`; `GET /events` (SSE: `hello {write, reason?, you?, max_bytes}`,
  `state` on connect and on change, `chat` with `id:`, `: ping` every 15 s; resumes from
  `Last-Event-ID` or `after`); `POST /chat` (201 with the message; 403 by the post policy or a
  cross-origin `Origin`, 415 not JSON, 413 over 256 KiB, 400 bad body or `ChatError`, 409 an answer
  to a closed decision, 400 a secret that reads as a value, 500 store failure); `POST
  /chat/preview` (who a text would reach; stores nothing); files under DIR with `Cache-Control:
  no-store`, `DIR/decisions/*` sandboxed by CSP; 421 on an unknown `Host`; on a manager's server
  `/f/<fleet>/…` proxied to that fleet's server. Pinned by test_chat, test_chat_serve and
  page.test.mjs.
  The most a post may be is `MAX_POST_BYTES`, 256 KiB, given to the page as `hello`'s `max_bytes`; the
  413 says `This message is N KiB; the most a message can be is 256 KiB. Shorten it, or put the long part
  in a file and give its path.` (N the body's size, rounded up), and the page says the same before
  sending a body over the limit, keeping the text. Why 256 KiB and not unlimited: the session's chat
  watch prints every message into an agent's context, and 256 KiB, about 64k tokens, is the most one
  message should cost.
- **render_dashboard.py** `STATE OUT [--fragment]`: validates, stamps `updated`, rewrites STATE,
  and writes the page: `assets/dashboard.html` with `/*__STATE__*/` replaced by `fleets.view(state)`
  (`<` escaped), as a full document or a bare fragment. The template is built, not written by hand:
  `fleet/page/` (Solid 2.0, D14) compiles into it with `just build-page`, keeping that contract (its
  opening `<title>`/`<link>` lines, one `/*__STATE__*/` inside `<script id="fleet-state">`, and the
  rules as `<script id="fleet-core">`, which page.test.mjs evaluates).
- **served.py**: every port `tailscale serve` exposes but the dashboards, with the process, its
  cwd and the fleet whose session started it (by its parents, else by the first transcript that
  wrote its address).
- **spend.py** `DIR`: `<output> tokens written and <input> read (<cached>% from the cache) in <n> answers`
  from the session transcript, or `no transcript for DIR: …`; exit 1 on bad usage.
- **usage.py** `capture [-- COMMAND...]` keeps a status line's `rate_limits` in
  `REGISTRY/usage/reading.json` under the account the session is logged in as, then runs COMMAND on
  the same stdin and exits with its code (127 when it can't run). The status line's input names no
  account, so the account is read from the session's config: `$CLAUDE_CONFIG_DIR/.claude.json`, else
  `~/.claude.json` (where Claude Code keeps it), its `oauthAccount` only. KEY is
  `<accountUuid>:<organizationUuid>` (the organization's plan carries the limits; `<accountUuid>`
  alone without one), `email` its `emailAddress` or null; a config with no file or no login is
  `unknown` (email null), and a file there that does not parse keeps nothing. Per account, a window's
  figure replaces the held one when it resets later, or resets at the same time with a higher
  percentage (`at`: when it was taken); a window the input leaves out is kept. Every capture with a
  window sets the account's `seen` and writes it first in `accounts`; another account whose windows
  have all reset is dropped; the file is written only when its bytes change. The flat file from
  before accounts (`{five_hour, seven_day}`) reads as `unknown`, `seen` its newest `at`.
  The manager's view gets `usage`: the account with the highest `seen` (the first on a tie),
  `{account: email, seen, five_hour?, seven_day?, others: [the same, without others, for every other
  account, highest seen first]}`, or null. `show` prints each account (`<email>, the session that
  worked last:` then `<email>:`, `an account not recorded` for null) and its windows indented.

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
- **The public ports of root-mode previews**: for each [root-mode preview](#the-preview-fleet-preview)
  whose record names a public port and a started dev server (a pid recorded), the hub also listens on that
  port, in the same two places (127.0.0.1 and the Tailscale IPv4, never 0.0.0.0), and passes every path
  there to that dev server at its root. It looks every second and at start, so a restarted hub listens
  again from the records alone, and it lets a port go when the preview stops. A port it cannot take (held
  by another process) is logged and reported, never fatal: `REGISTRY/hub/previews.json` holds `{pid,
  ports[] {port, fleet, worker, loopback, tailnet, error}}` while it runs, read by `fleet preview status`
  and the page. A port named by two records goes to the first; the hub's own port is never one. Plain
  http, no `tailscale serve` entry per preview (TLS on these ports is a later step).
- **Dev-server ports**: `fleet ws add` records a `port` on each workspace it makes: the first one from
  `FLEET_PORT_BASE` (5300) that no active workspace or preview of any fleet this machine serves holds; a
  handed-over workspace keeps its port. `fleet brief` gives a worker with a lane a `Dev server:` line: the
  fleet's per-worker preview when the combined preview's server runs, else its port (Vite
  `--port N --strictPort`, else `PORT=N`), stopped before it reports.
- **`fleet tell FLEET|all TEXT`**: the user's words from a terminal, through the page's door: a POST
  to the hub's `/f/<fleet>/chat` on loopback, so the message is the user's (`author` the hub's owner),
  addressed as the page addresses it (`@worker` in the text). `all` is every fleet served; a name
  resolves as below. It refuses inside a Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`):
  an agent writes as itself with `chat say`. No hub running refuses too.
- **Fleets by name**: wherever a command takes a fleet's directory first (`state`, `chat`, `ws`,
  `preview`, `brief`, `turn`, `advisor`, `serve`, `spend`), a bare name (no `/`, not a directory here)
  is looked up among the fleets this machine serves: its id on the hub, an id it had before, or its
  session's name wins; else the one fleet whose id or session starts with it, else the one containing
  it (any case). `fleet preview ui start` is ui-coordinator's directory when it is the only fit. Several
  fits refuse with exit 2 (`fleet: 'coord' fits infra-coordinator, ui-coordinator: give more of the
  name`); no fit passes as given. `fleet ls` (or `fleet list`) is `fleet fleets list`.
- **Who holds the port**: `hub.json` records `supervised` (started by systemd or launchd). A supervised
  hub that finds loopback's port held by a hub started by hand (the recorded pid runs `… hub`) stops it
  (SIGTERM, up to 5 s) and binds, logging `took over from a hub started by hand (pid N)`; anything else
  on the port stays an error. A hub started by hand while one already serves prints that one's address,
  says it leaves it, and exits 0.
- **New code**: the page is read at each request, the server's code only at start. Under a
  supervisor (systemd's `INVOCATION_ID`, launchd's `XPC_SERVICE_NAME`), or with `--reload`, the hub
  looks at its sources (`fleet/src/**`, `package.json`, `bun.lock`) every 15 s and, once a change has
  held still for one look, stops and exits 75, so `Restart=on-failure` (launchd: `SuccessfulExit =
  false`) starts it on the new code. `--no-reload` turns it off; a hub run by hand does not watch.
- **Routes**: `GET /` the index (every fleet of this machine, then each peer hub's, with the plan's
  usage, the gate and what else the machine serves), `GET /events` its stream (`fleets` events, on
  change, `: ping` every 15 s), `GET /api/fleets` this machine's fleets (`{name, fleets: [summary
  without index, role]}`, what a peer hub reads). `/f/<fleet>/…` is serve_dashboard.py's routes for
  that fleet, same bodies and status codes: the page (rendered from `state.json` at each load, the
  file `index.html` when the state can't be read), `GET /chat?after=N`, `GET /events` (`hello`,
  `state` on connect and on change, `chat` with `id:`, pings; `Last-Event-ID` or `after`), `POST
  /chat` (201; 403 policy or cross-origin `Origin`; 415; 413 over 256 KiB; 400 bad body, `ChatError`,
  unknown decision or a secret's value; 409 an answer to a closed decision, or an allow-once a
  [permission](#permission-grants) cannot grant; 500 store failure),
  `POST /chat/preview`, `GET /skills` (below), the preview (`/preview/…`, HTTP and WebSocket, and `POST
  /preview-workers`; see [The preview](#the-preview-fleet-preview)), the files under DIR (`Cache-Control: no-store`, `decisions/*` with the
  sandbox CSP; dot files and paths out of DIR 404). `/f/<fleet>` redirects (301) to `/f/<fleet>/`;
  `/f/<a>/f/<b>/…` is `/f/<b>/…`, so the manager's page, whose coordinators' links are relative,
  works under `/f/manager/`. 421 on a `Host` the hub doesn't answer to (loopback, `localhost`, the
  Tailscale IP, the MagicDNS name and short name, at its port; the https name with `--https`). On a
  root-mode preview's public port every path is that preview's (no index, no fleets), with the same 421
  rule at that port.
- **Skills** (`GET /f/<fleet>/skills`, the page lists them on a `/` at the start of a message in
  the composer, and of an answer or a note on a decision's page): `{"skills": [{name, description, hint, source, model}], "builtins": false}`, sorted by
  name (code point order). `source` is `plugin`, `user` or `project`; `hint` is the `argument-hint`
  or empty; `model` is false when `disable-model-invocation: true`. A skill with `user-invocable:
  false` is left out (the user cannot type it). Read from disk, frontmatter only (the top-level
  scalar keys; plain, quoted, `>` and `|` blocks), held 60 s per fleet. The sources, with Claude
  Code's config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) as `CONFIG`:
  1. this plugin (the checkout the hub runs from): its `skills/` and the dirs its
     `.claude-plugin/plugin.json` `skills` lists, named `tstack:<name>`;
  2. every other plugin in `CONFIG/plugins/installed_plugins.json` (a `project` or `local` install
     only when its `projectPath` is the fleet's repository) that is enabled: `enabledPlugins`
     (`<plugin>@<marketplace>`) of `CONFIG/settings.json`, then of the repository's
     `.claude/settings.json` and `.claude/settings.local.json`, the later winning, else the plugin's
     `defaultEnabled` (true when absent). A plugin named as this one is skipped. Its skills as
     above, plus its commands (`commands/*.md`, or what the manifest's `commands` names, which
     replaces that default), named `<plugin>:<name>`;
  3. the user's `CONFIG/skills/*/SKILL.md` and `CONFIG/commands/*.md`;
  4. the project's `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`, in the directory the
     fleet's session started in and each parent up to the repository root (`.jj` or `.git`). That
     directory is the first `cwd` the session's transcript records, else the `repo` of the ledger's
     first `workspaces[]` row; with neither, no project skills.

  A skill is named by its frontmatter `name` when that is a valid name (`[a-z0-9-]`, 64 at most),
  else by its directory; a command by its file name. Plugins' names are namespaced and never
  collide; of two bare names the first read wins, in the order above (Claude Code runs a personal
  skill over a project's with the same name), a skill before a command, the nearer directory first.
  `builtins` is false: Claude Code's built-in commands (`/clear`, `/compact`) are listed by no file
  on disk (only a running session's `system/init` message, which mixes them with skills), so they
  are not offered. A message the user sends that starts with `/<name> [args]` is stored as typed,
  with no field of its own: the host (and a worker, by `brief.md`) runs that skill with those
  arguments, as if typed in its session, and answers with `--re`. serve_dashboard.py has no such
  route; its 404 leaves the composer without a list.
- **Delivery to the coordinators** (TypeScript only: serve_dashboard.py stores the message and delivers
  nothing, so the manager forwards it as before). A message the user posts on the manager's page (not an
  answer to one of its decisions) whose recipients include live coordinators (`@<fleet>` resolves to
  `to: ["<fleet>"]` among the registry's fleets) is written, under the manager's store lock, into each
  one's own `DIR/chat.jsonl` through the chat store: `{id (its next), at, from: "user", to:
  ["coordinator"], text, re, parts (one plain part), author?, quote?, side?, via: {fleet: "manager", id:
  N}}`. Its `re` is the coordinator's own message when N answers one mirrored from it (or a copy it has),
  else null; a side chat opened on the manager's page opens one there, a later message of it continues
  that one (a new one when the fleet has none of it); else the copy inherits its parent's side. The
  manager's message is stored with `delivered: [{fleet, id}]`, one row per copy (the link; a fleet whose
  chat cannot be written is left out of it, and the manager's watch prints the message for it as before).
  A fleet not served is no recipient: `@<gone>` stays text, the message goes to the manager (the page's To
  line says so), and the manager forwards it. *The courier*: every 300 ms the hub reads what each live
  coordinator's chat gained (from its start on a hub's first read) and mirrors each message from
  `coordinator` whose `re` is a delivered copy onto the manager's page: `{from: <fleet>, to: ["user"], re:
  N, text, parts (one plain part), quote?, side (N's, when it has one), via: {fleet, id}}`, at the
  answer's own `at`. Under the manager's lock it writes nothing when a message with that `re` and `via`
  (the fleet by its id or an alias) is there, so a re-read or a restarted hub never writes it twice. Why
  the courier and not the write path: the coordinator answers with `fleet chat say`, which the CLI writes
  without the hub, so only a reader sees it; the hub is the one process always running that already
  reads every fleet's files, and nothing in the CLI writes another fleet's chat.
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
  the https address when that matters. The stream's `hello` says `{write, reason?, you?, max_bytes}` from the
  same rule. A message's `author` is the login (the owner's, from loopback). The hub never passes on
  a client's own `Tailscale-*` headers: the preview sets them from what it verified (see [The
  preview](#the-preview-fleet-preview)), and a fleet's page on a peer hub is asked with `Accept`,
  `Content-Type` and `Last-Event-ID` only.

## Permission grants

TypeScript only: `state.py` has no `permission` kind, no trace has one, and the oracle's usage texts
stay Python's (below). Auto mode refuses a worker's tool call; the plugin's hook opens a permission for
it, the user answers on the page, and the hub, not an agent (Claude Code's classifier refuses an agent
that writes its own allow rule), adds a one-time allow rule to the session's settings. The hook
removes the rule once the call has run, or at the first tool call of the session after 30 minutes (one
constant on each side: the hook's `GRANT_TTL_S`, `permission.ts`'s option text).

- **An exact rule**: `Bash(<call>)`, for a call that holds none of newline (`\n`, `\r`), `*` (a rule
  reads it as a wildcard) and `\` (Claude Code's rule parser reads an escape, so the rule would not match
  the call). This one set is `whyNoRule` in `src/ledger/permission.ts` and `NO_RULE` in the hook; the CLI
  refuses a permission for any other call, the hook opens an action with `--manual` for it, and the hub
  grants none.
- **Opening** (`fleet state DIR decision ID --kind permission --title T --question Q --why W --tool
  Bash --call CALL --cause CAUSE --root ROOT [--agent-id AID] [--agent WORKER] [--blocking]`): the row
  gets `refusal: {tool, call, rule, cause, root, agent_id}` with `rule` = `Bash(CALL)` and `agent_id`
  null without `--agent-id`, and the two options the CLI sets: `allow-once: Allow this call once |
  the hub adds <rule> to <root>/.claude/settings.local.json; the plugin hook removes it once the call
  has run, or at the first tool call of the session after 30 minutes` and `deny: Deny | the worker stays
  stopped; your note goes to it`. Refused: a tool other than Bash, a CALL no exact rule can hold (above),
  a relative ROOT, `--option`, `--recommend`, a
  permission without `--tool --call --cause --root`, and those flags on any other kind. A value that
  starts with `-` is given as `--call=VALUE`. The same command on the open row revises it (a changed
  refusal re-presents it and clears a hold); `--decide`, `--withdraw` and `--hold` work as for any
  decision. `permission` is accepted by `--kind` but left out of its listed choices, and the five
  flags out of the usage (as argparse's `help=SUPPRESS`), so every usage text stays the twin's.
- **Answering**: the page's form shows the call as an `sh` block, its cause, the rule and the file it
  goes into, the two options and a note; the answer is `allow-once: Allow this call once` or `deny:
  Deny`, the note on the next line, and the POST body carries `rule`, the rule the page showed.
- **Granting** (`src/hub/grants.ts`, before `POST /chat` stores an answer that starts with
  `allow-once` to a permission): the row must be open, its `refusal` a Bash call an exact rule can hold
  whose `rule` is `Bash(<call>)`, the POST's `rule` that same rule (absent or different refuses: a row
  revised since the page rendered it needs a fresh look), and its `root` absolute, a directory, and a
  session root of this fleet (the ledger is writable by agents, the hub is not): the `project` or `cwd` of
  a heartbeat in `DIR/heartbeats/`, or else the working directory, read by the hub from the OS (`procs.ts`
  `cwdOf`), of the live process the registry's entry for DIR names as its `pid` (`fleet serve DIR
  [--pid PID]`: the session that served it). The second covers a session that writes no heartbeats (one
  whose fleet DIR is not in its scratchpad and that has no `FLEET_DIR`, or one started before the hook
  wrote them). The refusal says what it checked: `... is no session of this fleet (no heartbeat names it,
  and the fleet's registered session <pid> runs in <cwd>)`, or `... and no live session is registered
  for this fleet`. A worker's workspace is no session root, under the fleet or beside the repo: the hook
  records `$CLAUDE_PROJECT_DIR` as `--root`, the session's root, for a subagent's refused call too (only
  the session root's settings apply, to its background subagents as well). Under the settings lock (below), `<root>/.claude/settings.local.json` (absent reads as
  `{}`; one that does not parse refuses) gets the rule added to `permissions.allow`, every other key and entry kept, written
  through a temp file in its folder and a rename, two-space JSON with a final newline. A missing
  `.claude` is made, and the grant says `reload: restart` (Claude Code watches only a settings folder
  that existed when the session started), else `live`. Then one line is appended to `DIR/grants.jsonl`:
  `{"op":"grant",decision,ref,rule,agent_id,file,at,by,reload}`, `agent_id` the row's `refusal.agent_id`
  (null: the session's main thread), `by` being `tailnet:<login>` for a
  tailnet peer that is not this machine (`tailscale whois`), else `local` (loopback, whatever header it
  carries, or this machine's own tailnet address); then the answer is stored. A rule already in `permissions.allow` is
  someone's own: the hub writes nothing and appends no grant line, so the hook never removes it, and the
  answer is stored as usual. A failed check answers
  409 with the reason and stores nothing. A `deny` is stored as any answer.
- **Removal** (the plugin's hook, PostToolUse and PostToolUseFailure): a grant is `used` when the call
  that just ran is its rule's call and the hook's `agent_id` (absent on the main thread) is the grant's;
  it is `expired` 30 minutes after its `at`. The hook takes the rule out under the settings lock, then
  appends a `remove` line, `{"op":"remove",decision,rule,file,at,why}` (`why`: `used` or `expired`), which
  ends the grant with the same `decision` and `rule`. Two hooks sweeping at once are kept apart by a
  `flock` on `grants.jsonl`, so a grant is closed once.
- **The settings lock**: hub and hook both make the directory `<dir of the file>/.settings.local.json.lock`
  (an atomic `mkdir`, which Bun and Python both have; Bun has no `flock`) around the read-modify-write of
  the settings file, retry for up to 2 s, and take over a lock older than 10 s (a crashed holder's). A
  lock still held after 2 s refuses the grant (409) or leaves the removal for the next tool call.
- **Lines**: every `grants.jsonl` line is compact JSON, one object, on both sides.
- **What it defends**: an allow rule that lets through only the call the user saw, for its caller, once.
  Not more: a local process can POST allow-once to the hub (stamped `local`, by decision), and heartbeats
  and the ledger are writable by agents, as is the registry (`fleet serve DIR --pid PID`), so the root
  check and the row make a forged grant flagrant, not impossible; the registry names a process, and the
  hub reads where it runs, so a forged entry grants only in a directory some live process of the user's
  runs in. A forged `op:grant` line can make the sweep remove a rule that matches it, one added by hand
  included: the failure is fewer allowed calls, never more. The 30 minutes run only while some session of
  the fleet makes tool calls.

## Heartbeats

The per-tool-call heartbeat stays in the plugin's Python hook dispatcher (D13): `hooks/tstack-hook`'s
`fleet_heartbeat` runs on PostToolUseFailure, SubagentStart and SubagentStop (registered `async`, so no
tool call waits on it) and, inside the synchronous dispatcher, on SessionStart, Stop and PostToolUse
(synchronous since the chat nudge reads its output: see [Listening hooks](#listening-hooks)).

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
  atomically (a dot-file then a rename): `{session, agent, agent_type, worker, cwd, project, workspace, path,
  tool, event, at, transcript, agent_transcript}`. `project` is `$CLAUDE_PROJECT_DIR`, the session's
  project directory, which a [permission grant](#permission-grants) names; `cwd` follows its shell. `workspace` is the jj workspace's name, read from
  `.jj/working_copy/checkout` (no jj process); `path` is the tool's absolute `file_path`,
  `notebook_path` or `path`; `at` is a stamp from the fleet's clock (`FLEET_NOW`, local time with its
  offset). A start or a stop (no tool) keeps the `tool` the file already had. Measured: 0.35 ms median in process inside a fleet, under 0.5 ms outside one; the hook
  process itself is Python's start-up (~30 ms), which a PostToolUse now waits for.
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

## Listening hooks

A host deaf to its chat leaves the user's messages unread and answers unrecorded: the watch exits with
the news it prints, and a session that forgets to arm it again, or works a long turn of its own, hears
nothing. Two handlers of the same dispatcher (`hooks/tstack-hook`) make listening mechanical, for the
coordinator and the manager only. Membership is the heartbeat's (`$FLEET_DIR`, else the scratchpad's
folders holding a `state.json`); the role is the ledger's (`role: "manager"`, else coordinator). A worker
(a subagent's `agent_id`, `FLEET_WORKER`, `TSTACK_ROLE=worker`) is out of both. Neither ever fails the
hook: a broken `chat.jsonl` or ledger is skipped, an error is logged.

- **The Stop guard** (`fleet_listen_guard`, Stop). When a fleet the session hosts is running or blocked
  (not paused, not done) and no chat watch as its role is alive, the hook returns
  `{"decision": "block", "reason": ...}`, so the turn goes on with: `Your chat watch isn't running, so
  the user's messages and answers go unheard. Arm it as a background command (`run_in_background:
  true`, `timeout: 3300000`): `<plugin>/fleet/bin/fleet chat DIR watch --as ROLE --all --resume --once`.`
  The manager's adds when `--fleets` goes on. A watch is alive when `DIR/watch-ROLE.pid` holds a live pid
  whose command line (`/proc/PID/cmdline`, `ps -p` on the Mac) is `... chat DIR watch --as ROLE`, DIR
  resolved against the process's cwd; failing that, any process with that command line (a watch armed
  this instant, before Bun wrote its pid file). Never twice in a row: not on a stop that already follows
  a stop hook's block (`stop_hook_active`), nor within 15 s of its last block (the session's
  `fleet-guard` state). Headless runs are guarded too.
- **The mid-turn nudge** (`fleet_chat_nudge`, PostToolUse). At most once a minute per session (on the
  fleet's clock, `FLEET_NOW`), it reads `chat.jsonl` from the byte offset it stopped at (a session's
  first look reads only the last 64 KiB; a torn last line waits), keeps the user's messages not yet
  answered (`re`) as pending in the session's `fleet-nudge` state, and when one has waited
  `FLEET_NUDGE_MIN` minutes reads the ledger and the watch's cursor once and tells the session, as
  PostToolUse `additionalContext`, one line per item, at most three and `Fleet: and N more.`:
  - a message to the role (or to no one named) after the cursor: `Fleet: #81 from the user, unread for 4
    min: "<first 80 chars>". Read the chat now (`<fleet> chat DIR inbox --as ROLE`) and answer or record
    it.`;
  - an answer to a decision still open (given after it was opened or revised, and not held after it),
    read or not: `Fleet: #82 from the user answers A7 (<title>), not recorded for 12 min: "<text>". Record
    it now (`<fleet> state DIR decision A7 --decide "..." --resolution "answered on the page (#82)"`),
    then answer #82 with --re.`
  Each message is told once. No process, no ledger read until something is due. Measured on a chat of
  2,000 lines: 0.96 ms median in process for a first look with an item due, 0.20 ms for the usual look
  from a kept offset.

## Workspaces (`fleet ws`)

A worker that edits code works in a jj workspace; the coordinator's own (`default`) is the stack. A new
workspace pays its own setup (dependencies, a dev shell, build caches), so the policy (Luiz, 2026-10-01)
makes as few as the work allows: sequential work **reuses** a lane's workspace (the default); a **fresh**
one is for parallel workers whose files could meet, risky experiments, and arena or swarm comparisons; and
a fleet may opt into one **shared** working copy (`workspace_mode: "shared"`).

- `fleet ws DIR add NAME [-r BASE] [--agent ID] [--repo PATH]`: `jj workspace add <repo>-NAME -r
  <BASE's commit> --name NAME`, beside the default workspace of the repo `--repo` (else the cwd) is
  in. BASE defaults to `@-` there and must name one commit. Refused: an invalid name or `default`, a
  name the ledger or jj already has, an existing directory, no jj repo. Records `{id, agent (--agent,
  else NAME), path, repo, base, added, status: active}`, logs a note, renders the page, and prints the
  path and the line for the brief.
  A worker the ledger has no row for yet is warned about (`ws: no worker row a9 yet: record it ...`):
  a worker is recorded, then briefed and spawned. A recorded, unpruned workspace whose worker is not
  running, queued or blocked and whose lane meets the new worker's (L7) is named, and the fresh one is
  still made: `ws: a1's workspace a1 covers b2's lane and nobody works in it (a1 done): reuse it: \`fleet
  ws DIR add b2 --reuse a1\` keeps its setup; a fresh one is for parallel work that could meet, a risky
  experiment, or a comparison`.
- `fleet ws DIR add WORKER --reuse WORKSPACE|WORKER [-r BASE]`: hands the active workspace named
  WORKSPACE (else the one whose worker is WORKER) to WORKER. Refused: none found; it is WORKER's already;
  its worker is running, queued or blocked (`ws: workspace a1 is a1's, and a1 is running: a workspace
  changes hands once its worker is done or stopped, never while it works there`); WORKER already holds
  one; its directory is no longer that jj workspace of that repo; `--agent` or `--repo` given. The
  workspace is snapshotted (a stale one updated first), then WORKER gets a change of its own: `jj new
  BASE` when `-r` is given, else `jj new` on top of what the last holder left unless its `@` is empty and
  undescribed, so the next worker never amends the last one's change. The row's `agent` becomes WORKER,
  `base` the new `@`'s parent, and `handovers` gains `{from: <the last holder>, at}`; a note event
  (`Workspace a1 handed from a1 (done) to b1 at PATH, on <change>.`), the page rendered, and the same two
  lines printed (`workspace a1 for b1 at PATH, reused from a1, on <change>`, then the brief line).
- **Shared mode** (`fleet state DIR set --workspaces shared`; isolated is the default). The workers share
  the coordinator's own working copy, the repo's `default` workspace, rather than one named shared
  workspace: it is already set up, which is the point of the mode (a named one would pay the setup once
  more and leave two working copies to keep in step), and `jj split` integrates on it directly. Only the
  coordinator moves history; the cost is that its own edits and history moves wait while workers write.
  There `fleet ws DIR add NAME [--agent ID] [--repo PATH]` makes and records nothing: it prints `shared:
  a1 gets no workspace of its own: this fleet's workers share one working copy, <root> ...` and the brief
  line for it (`-r` and `--reuse` are refused: there is no workspace to base or hand over); `agent` refuses
  a running lane that meets a live one ([state's agent](#commands)); `fleet brief` gives the shared-copy
  rules. Choose it for a repo whose setup is expensive and lanes that are truly disjoint.
- `fleet ws DIR split WORKER -m MESSAGE [--repo PATH]`: shared mode's integration. Refused in an isolated
  fleet, for a worker with no row, one still running, queued or blocked, one with no lane, and when
  nothing in the default workspace's `@` is in its lane. After a snapshot, the files `@` changes (a
  rename's both paths) that the worker's lane holds (the lane rule of [Warnings](#warnings) 6) go into
  `jj split -r @ -m MESSAGE root-file:"<path>"...` (with `ui.editor` set to `true`, so jj never waits on an
  editor): one described change below what is left in `@`, which keeps its change and description. The
  files on disk do not change, so workers still running carry on. Logs an `integrated` event (`Split a1's
  lane out of the shared working copy as <change> (N file(s)).`), prints `split a1: <change>: <files>`.
  One split per finished worker gives one described change per worker, in the order they were split.
- `fleet ws DIR list`: per active workspace (in a shared fleet with none, a line saying so), its worker and the worker's status and last-seen, then
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

## The preview (`fleet preview`)

Each code-writing worker edits in its own workspace, so the user saw another worker's UI only once the
coordinator integrated it. The preview (TypeScript only, approved 2026-10-01) serves every worker's edits
not yet integrated, merged, in one live page, and optionally one worker's alone.

- `fleet preview DIR start [--cmd C] [--port N] [--setup C] [--repo PATH] [--stack REVSET]`: the combined preview. Refused
  in a shared fleet (its one working copy already holds every worker's edits), for a fleet not served (the
  preview is reached through the hub), and while it already runs.
  - **Workspace**: `jj workspace add <repo>-preview --name preview` at the stack, made once and recorded in
    `workspaces[]` as `{id: "preview", kind: "preview", agent: null, ...}`: the fleet's, never a worker's
    (`fleet ws add --reuse preview` is refused; `list` shows it as the preview). Its @ is the merge: parents
    `heads(<each included worker's @> | <stack>)`. One worker: that worker's @; none: the stack.
  - **The stack** (the merge's base): the one commit a revset names, `start --stack REVSET` for that start,
    else the ledger's `preview.stack` (`fleet preview DIR set --stack REVSET`, kept beside `preview.cmd`;
    `set --stack ''` or `set --no-stack` clears it); without one, the default workspace's @, or its parent
    when that @ is empty and undescribed. The revset is resolved in the fleet's repo at every look, without
    a snapshot, so a bookmark or `<workspace>@` (`devloop@`) is followed as it moves. One that names no
    commit, several, or none jj resolves is refused: the look records why as the updater's error and
    changes nothing else, so the last good merge stands. The revset is for a repo whose default workspace
    is someone's own checkout: its @ holds the user's uncommitted work, which the coordinator never
    touches and the workers' merge should not sit on (in custom-mcp-servers, 826 files on a conflicted old
    change, which left `package.json` and `pnpm-lock.yaml` conflicted with "the stack"); the coordinator
    keeps its integrated stack in a workspace of its own and names it, `set --stack devloop@`.
  - **Dev server**: the command is `--cmd`, else the ledger's `preview.cmd` (`fleet preview DIR set --cmd C
    [--setup C]`, kept by Python as it keeps any key), else `<package manager> run dev` when package.json has
    a `dev` script, else refused with the reason. `{port}` and `{base}` in it are filled in; a command that
    starts a Vite or Vite+ dev server (`vite`, bare or `dev` or `serve`; `vp dev`; `vite-plus dev`; or a
    package.json script run by `<pm> [run]`, `vp run` or `vpr` whose body does) gets `--port P --strictPort
    --host 127.0.0.1 --base /f/<fleet>/preview/` (after `--` for npm); `vite build|preview|optimize`, `vp
    build`, `vp preview`, bare `vp` (its help) and anything else run as given with `PORT` set, at their
    root. The port is `--port` or a free one. A workspace with package.json and no node_modules is installed
    first (`--setup`, else the lockfile's frozen install: `npm ci`, `pnpm|yarn|bun install
    --frozen-lockfile`), so the install changes no tracked file. It runs detached, as its own process
    group, logging to `DIR/preview/combined.log`. `start` waits up to `FLEET_PREVIEW_WAIT_S` seconds (30)
    for it to answer; when its process ends first, `start` exits 1 with the last error of what this start
    appended to the log (`exited at start` on the server's line), else it says `not answering yet`.
  - **Updater**: `fleet preview DIR updater`, detached, logging to `DIR/preview/updater.log`. Every
    `FLEET_PREVIEW_S` seconds it snapshots each worker's workspace not taken out from outside (`jj -R <path>
    util snapshot`: jj takes that workspace's working-copy lock, records its files and writes none of them;
    the worker's own jj commands find it as they left it), reads every workspace's @ in one `log -r
    'working_copies()'` without a snapshot, drops each worker merged until integrated (below) whose
    workspace is gone or whose @ has no change left to integrate (no commit of `(::<its @> ~ ::(<stack> |
    trunk())) ~ empty()`, the stack as given above: trunk() counts because a coordinator that lands by moving a bookmark leaves the
    default workspace's @ behind; asked once per commit, stack and trunk), and stops there when no commit
    moved. Otherwise it rebases the
    preview's @ onto the new parents in place (`rebase -r preview@ -d …`, `--ignore-working-copy`, the
    change kept), and when the preview's @ is a commit its files are not at (a worker's snapshot rebases
    the preview's @, a descendant, in the same operation) runs `workspace update-stale` there, which
    writes only the files that changed, so the dev server's hot reload picks them up. A file the preview's
    directory had of its own (not ignored) is kept by jj in a divergent copy of the change, which is
    abandoned, and the updater says so. It stops when the record no longer names it.
  - **Conflicts** are not blocking: jj records them in the merge and writes their markers. The files are
    read from the commit (`self.conflicted_files()`, what `jj resolve --list` lists, with repository
    paths), each with the included workers whose changes ahead of the stack touch it.
- **Picking**: a worker with an active workspace is in the merge unless it was taken out (`exclude
  WORKER`): always when it is running, queued or blocked or was taken in (`include WORKER`); otherwise
  (done, failed, any other status) while its changes are not in the stack, so a done worker's work shows
  until it is integrated and drops out once its @'s changes are ancestors of the stack or of trunk(), or
  its workspace is gone. The page's boxes take in and out through the hub; the page's `included` is the same rule, from
  the last look's `merged`.
- `start --per-worker WORKER`: a dev server in that worker's own workspace (installed first when it has
  no node_modules), base `/f/<fleet>/preview/<worker>/`, logging to `DIR/preview/<worker>.log`. No merge,
  no updater: its files are the worker's.
- **Root mode** (`start --root`, `start --per-worker WORKER --root`, or the ledger's `preview.root`, set
  by `fleet preview DIR set --root` and taken back by `set --no-root`, kept beside `preview.cmd`): for an
  app that only runs at its root, whose client asks for `/api/...`, `/api/shapes` or a WebSocket at
  `/api/sala` absolutely (the Casos app: about 600 such lines across 100 files), so under
  `/f/<fleet>/preview/` its pages load and every data call 404s at the hub's root. The dev server is told
  base `/` (Vite: `--base /`; `{base}` is `/`) and its own free 127.0.0.1 port as before, and the preview
  is given a **public port**, on which the hub serves it at the root of an origin of its own,
  `http://<MagicDNS name>:<port>/` and `http://<tailnet IP>:<port>/` (`http://127.0.0.1:<port>/` without
  Tailscale). The port is given once per preview (the combined one, each worker's) and kept in the
  record's `ports {combined, workers {<worker>: port}}` across stops and starts, so the address stays
  good; `server.public` (and a per-worker server's) names it while that start runs in root mode. It comes
  from `FLEET_PREVIEW_PORTS` (`LO-HI`), **7500-7599** by default: beside the hub's 7420 and 7443, clear of
  the ports this machine's other servers use (Vite's 5173, 5300 and up for workers' dev servers, the
  apps' 24116-24118, 9787-9791, 8444) and below the kernel's ephemeral range (32768 and up on Linux, 49152
  on the Mac), where the dev servers' own free ports land. A port is skipped when another fleet's record
  holds it, when it is the hub's (7420, 7443, or what `hub.json` records), when `tailscale serve` exposes
  it, or when something listens on it on 127.0.0.1 or the tailnet IP now; a range with none left is
  refused. `start` and `status` print the public address and what the hub says of the port (`the hub
  listens on it (127.0.0.1 and <ip>)`, `the hub cannot listen on port N: …`, `no hub runs`); `start`
  waits up to 3 s for a running hub to take the port. These addresses are plain http, so the page there
  has no secure context: `navigator.clipboard` and the other secure-context APIs are unavailable. The
  `/f/<fleet>/preview/` path still leads to the same server, with the prefix stripped.
  - **Security**: the dev server stays on 127.0.0.1; only the hub faces the tailnet, on the two addresses
    it binds its own port on. The public port carries the same identity rule as `/f/<fleet>/preview/`
    (below): the client's `Tailscale-*` and `X-Forwarded-For` dropped, then set from what the hub
    verified; `Host` rewritten to `127.0.0.1:<dev port>`; a write (not GET, HEAD or OPTIONS) the chat's
    writers' only; a stopped dev server 502. Every request and WebSocket carries `X-Forwarded-Prefix: /`,
    the proxy marker: an app's guard that reads `X-Forwarded-Prefix` as "came through a proxy" (the Casos
    dev guard does) asks such a request for a login instead of trusting loopback.
- **The dev servers' environment**: every dev server the preview starts (combined, per-worker, root mode
  or not), its install and the updater inherit the environment `fleet preview DIR start` ran in,
  unchanged but for `PORT`, `BROWSER`, `NO_COLOR` and `FORCE_COLOR`. Dev secrets come that way only:
  any loader that runs a command with secrets in its environment wraps `start`, e.g. `secretspec run --
  fleet preview DIR start ...` or `op run --env-file=<file of op:// references> -- fleet preview DIR start
  ...` (the file holds references only, never values); nothing writes or copies a secret file. secretspec's
  1Password provider can fail to reach the desktop app (`connecting to desktop app … timed out`) where `op`
  works: `op run --env-file` is then the fallback. Nothing else starts a dev server (the updater merges,
  the hub proxies), so a server that dies is started again by `start`, under the same loader.
- `status`: the address, the stack (`stack: devloop@ (<commit>)`, or `stack: the default workspace's @
  (<commit>)`), the dev server (pid, port, answering), the updater, each worker's workspace
  (`[x]` merged at its commit and change, `[ ]` and why not: `running`, `taken in`, `taken out`, `done,
  merged`, `done, already in the stack`, `done, its workspace is gone`), the conflicts, the updater's last error and
  the dev server's last error (below); the same for each per-worker preview.
- `stop [--per-worker WORKER | --all]`: TERM, then KILL after 3 s, to each process group (the updater
  first): plain `stop` stops the combined preview's dev server and its updater and leaves each per-worker
  preview running (it names those); `--per-worker WORKER` stops that one alone; `--all` stops the combined
  preview and every per-worker one. The record keeps the ports with no pids. The workspace stays for the next start. **`fleet ws prune`** keeps
  the preview's workspace while its dev server or its updater runs (`ws: kept preview: the fleet's preview
  is running (...)`) or when its @ holds changes of its own; otherwise it forgets it, abandons its merge
  commit, deletes the directory and the record.
- **The record**, `DIR/preview.json`: `{fleet, workspace, path, repo, server {cmd, port, pid, base, path,
  log, started, public}, updater, include[], exclude[], merged[] {id, workspace, commit, change}, stack,
  stack_from (the revset the last merge's stack came from, null for the default rule), stack_given
  (`start --stack`'s, for that start), commit, conflicts[] {path, workers[]}, error, updated, workers[] (per-worker servers), ports {combined,
  workers}}`. It is not a key of
  `state.json`: it has three writers (the coordinator's commands, the updater, the hub), and `state.json`
  has one writer and no lock. Each change is made under an exclusive `flock` on `DIR/preview.lock` and
  written whole through a rename. A pid counts as running when the process exists and is no zombie.
- **The dev server's last error** (`status`, the page): in the last 400 lines of its log, colours
  stripped, the burst of lines around the last one that reads as an error (from the first error line
  after the last time-stamped line that was none, so Vite's "Internal server error" and its parse error
  lead), without stack frames and box drawing, ten lines at most; none once the server logs a page reload
  or an HMR update after it.
- **The hub**: `/f/<fleet>/preview/…` goes to the combined preview's dev server and
  `/f/<fleet>/preview/<worker>/…` to a per-worker one (a per-worker preview's name wins over a path of the
  combined one); `/f/<fleet>/preview` redirects (301) to the slash. HTTP is passed with the path kept for
  a server told its base (stripped, and its root redirects put back under the prefix, for one at its
  root), `Host` set to the server's own `127.0.0.1:<port>` (Vite refuses a host it does not know, such as
  the tailnet name), hop-by-hop headers and `Accept-Encoding` dropped. A WebSocket upgrade (Vite's HMR, on
  the `vite-hmr` protocol, its token in the query) is piped to `ws://127.0.0.1:<port><path>` both ways,
  the protocol echoed, messages queued until the dev server's end opens. HTTP and the WebSocket alike
  carry `X-Forwarded-Prefix` (the hub's path for the server), the proxy marker. A request that could change
  something there (not GET, HEAD or OPTIONS) is the chat's writers' only (403 otherwise); a missing
  preview is 404, a stopped server 502. `POST /f/<fleet>/preview-workers` `{worker, include}` takes a worker
  in or out under the chat's post policy (403, 415, 413, 400 as for `POST /chat`) and answers `{include,
  exclude}`. Peer hubs' previews are not passed through.
- **Who the dev server sees**: the hub never passes a client's `Tailscale-*` headers or
  `X-Forwarded-For`; it sets them from what it verified (`proxiedIdentity`, HTTP and the WebSocket
  alike). A request on loopback that carries `Tailscale-User-Login` came through `tailscale serve`, which
  set it, so its `Tailscale-*` headers (and `X-Forwarded-For`) go on as they came; one from a tailnet
  peer carries `Tailscale-User-Login` as `tailscale whois` gives that peer (none when it gives none) and
  `X-Forwarded-For` its address; a plain loopback request carries none. Before this, any tailnet peer
  that sent `Tailscale-User-Login` to the hub's tailnet address reached the dev server on loopback with
  that login, and an app that trusts loopback plus the header (the Casos app's dev guard) answered as
  that user. An app behind the preview may trust `Tailscale-User-Login` only from the hub's proxy, which
  sets it; it must not trust loopback alone, since every proxied request arrives from loopback.
- **Why a path, not a port per preview**: evidence from Vite 8.3.2 (create-vite 9.2.1) behind a Bun proxy
  in headless Chromium: with `--base` every URL the page asks for (`@vite/client`, `@react-refresh`, the
  sources, the pre-bundled deps) is under the base, and the HMR client opens its socket at the page's own
  origin (`import.meta.url`: `wss` under https) and the base, so one hub port (and `tailscale serve`'s
  https in front of it) carries every preview, with no Tailscale config per preview; the `Host` rewrite
  answers Vite's `allowedHosts`. A port per preview through `tailscale serve` would need Vite told the
  MagicDNS host (config or an undocumented environment variable), a serve port allocated and freed per
  preview, and changes to tailscaled's persistent config; it stays the way for a server whose base is
  set only in its config (Next's `basePath`), which this does not do yet. A page with hard-coded absolute
  URLs (`/icons.svg`) misses the base either way: that is what root mode is for, on a port the hub owns
  (no `tailscale serve` entry per preview and no change to the app), at the cost of plain http.
- **The page** (the view's `preview`, only when `DIR/preview.json` exists, so no trace changes): `{url
  ("preview/", or null with only per-worker ones), address, running, up, port, log, updater, every,
  workers[] {id, name, status, included, commit, change}, conflicts[], error, updated, per_worker[]
  {worker, url, address, running, up, port, log, public, public_error}, public, public_error}`, `public`
  the root-mode public port or null and `public_error` the running hub's word on it. The Fleet view's
  Preview block links a root-mode preview (and each per-worker one) at `http://<the page's own
  host>:<public>/`, says it is plain http (no secure context, no clipboard) in the link's title, and
  shows `public_error`. It also shows the link, a box
  per worker's workspace (disabled for a viewer who may not write; put back when the hub refuses), the
  conflicts with the workers' names, the build error and each per-worker preview; the Links view lists
  the combined and per-worker links. The hub's view of a fleet is recomputed when `state.json` or
  `preview.json` changes, so the stream carries the updater's news.

## Rules as commands (`fleet brief`, `fleet turn`)

Rules the skills asked the model to remember, now kept by the CLI (stage 5; the inventory and each
rule's disposition are in [RULES.md](RULES.md)). Beside the refusals and warnings above:

- `fleet brief DIR WORKER` prints the part of a worker's brief the ledger holds: the line it opens with
  (`Read DIR/brief.md first; your id is a1.`), `Task:`, `Done when:` (the row's `brief`, a leading
  "done when" dropped), `Skill:` (a skill of this plugin whose SKILL.md says
  `disable-model-invocation: true` is read with the Read tool, by its path, since the Skill tool
  refuses it to a worker; any other is called with the Skill tool as `<plugin>:<skill>`; `none`
  prints no line), `Lane:`, `Workspace:`, `Step:` (the worker's current step) and `Chat:`. `Workspace:`
  carries the rules of history that go with the fleet's mode, so `assets/brief.md` says them once for both:
  in an isolated fleet, the active `workspaces[]` row of the worker, `yours alone`, who held it before when
  it was handed over (`It was a1's before you: what a1 left is under your @`), and that the worker ends
  with its changes described there while rebasing, bookmarks and pushes are the coordinator's; in a shared
  fleet, for a worker with a lane, the shared working copy (a recorded workspace's repo, else the default
  workspace of the repo the command runs in), that the worker edits only its lane there, moves no history
  and describes nothing (no `jj new`, `jj edit`, `jj rebase`, `jj describe`, nor `split`, `squash`,
  `commit`, `abandon`, `restore`), and that the coordinator splits the copy by lane paths into one
  described change per worker. On stderr, for the coordinator: a missing completion criterion, a lane
  with no workspace (isolated only), and the model to spawn it on with the `--task-id` to record after. A worker
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
| `chat watch` | `DIR/watch-WHO.pid`, `.cursor`, `.left`, `watch-coordinator.told`, `watch-manager.told`, and with `--fleets` `watch-manager.fleets.json` |
| any reader of the registry (`fleets.py`, a manager's `chat.py`/`state.py`, the render) | deletes dead `REGISTRY/*.json`, renames entries after a session title |
| `fleets.py gate take/free`, `name` | `REGISTRY/gate/gate.json`, `REGISTRY/<fleet>.json` |
| `serve_dashboard.py` | `DIR/server.json`, `DIR/server.log`, `REGISTRY/<fleet>.json` |
| `fleet serve` | `REGISTRY/<fleet>.json` (removed with `--stop`) |
| `fleet hub` | `REGISTRY/hub/hub.json` while it runs; `DIR/chat.jsonl` on a post, and on a post to the manager's page each addressed coordinator's `DIR/chat.jsonl`; the manager's `DIR/chat.jsonl` (the courier's mirrored answers); on an allow-once to a permission, `<root>/.claude/settings.local.json` (and its folder) and `DIR/grants.jsonl` |
| the plugin's hook (grant removal) | `<root>/.claude/settings.local.json`, `DIR/grants.jsonl` (`remove` lines) |
| `usage.py capture` | `REGISTRY/usage/reading.json` |
| the plugin's hook (`fleet_heartbeat`) | `DIR/heartbeats/<session>[.<agent>].json` |
| the plugin's hook (`fleet_listen_guard`, `fleet_chat_nudge`) | nothing in DIR; the session's `fleet-guard` and `fleet-nudge` state in the plugin's data folder |
| `fleet ws add` / `prune --apply` | `DIR/state.json` (`workspaces`, `events`, `updated`), `DIR/index.html`; the workspace directory made / deleted (a shared fleet's `add` writes nothing) |
| `fleet ws add --reuse` | `DIR/state.json` (`workspaces`, `events`, `updated`), `DIR/index.html`; a new change in the workspace (`jj new`) |
| `fleet ws split` | `DIR/state.json` (`events`, `updated`), `DIR/index.html`; the default workspace's `@` split in two |
| `fleet preview start` / `stop` / `set` | `DIR/state.json` (`workspaces` with the preview's row on its first start, `preview` by `set`, `events`, `updated`), `DIR/index.html`; `DIR/preview.json` (under `DIR/preview.lock`); `DIR/preview/*.log`; the `<repo>-preview` workspace (made once); a node_modules install in a workspace that has none |
| `fleet preview include` / `exclude`, the hub's `POST preview-workers` | `DIR/preview.json` |
| `fleet preview`'s updater | `DIR/preview.json` when the merge changed; the preview workspace's @ (rebased) and its files (`update-stale`); jj's operation log (each worker snapshot that records an edit) |
| `fleet ws prune --apply` of the preview | its directory deleted, its merge commit abandoned, `DIR/preview.json` removed |

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
for `test_corpus.py` and `test_model.py`. The corpus: `ledger-lifecycle`, `decisions`, `hold`,
`plan-and-grill`, `chat`, `manager` (written by hand from the tests), `manager-news` (the manager's
`--fleets` watch and `fleets waiting`), `delivered` (what the hub delivered: the marks, the manager's
watch and news leaving it out), `emptied` (open-7), `workspaces` (`set --workspaces`, the shared
fleet's refusal of lanes that meet, the isolated fleet's warning, `show`, validation, a render),
`model-seed-1`, `model-seed-2` (random sequences), and the page's: `render-<name>` for each
hand-written trace, the same steps with every state command rendering, plus `render-page` (a
session's scratchpad with its transcript, links, markup and U+2028 in the text, unread chat, a
manager with a coordinator's summary, the plan's usage and the gate). Where a behaviour marked open changes on purpose, re-record
the trace with the Python oracle and edit the expected lines by hand, or record them from the
new implementation once it's the reference. Either way, review the diff.

## The model-based test

`oracle/test_model.py` drives 25 random sequences of 60 steps (a fresh seed each run;
`FLEET_MODEL_SEED`, `FLEET_MODEL_SEQS`, `FLEET_MODEL_STEPS`) through state.py and chat.py, with a
model: milestones and their step order, workers (status, milestone, rounds, name, tokens, lane), the
fleet's `workspace_mode` (two sequences in five start shared),
decisions (kind, status, number, place, options, recommendation, hold), roadblocks, kept notes, links,
the event count, and the chat's messages. The clock moves 0-25 minutes per step. Checked after
every step:

- the exit code the model predicts (0, 1, 2), with no traceback;
- a refused command changed neither `state.json` nor `chat.jsonl`;
- the ledger's shape equals the model's (the fields above, the step order, the event count);
- stderr is exactly the warnings the model expects: the stale Now line with its age in minutes,
  live rows in a paused or done fleet, a chat nobody reads (computed on the ledger before the
  command), a Now line naming a closed decision, an answer on the page not recorded, decisions left
  open by `set --status done`, lanes that meet in an isolated fleet (a refusal in a shared one); on a
  validation refusal, those plus the reason, and nothing on stdout;
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
