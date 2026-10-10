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
[Listening hooks](#listening-hooks) · [The news](#the-news-fleet-news) ·
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
| `FLEET_UNANSWERED_S` | chat.py | how long the user's message to a fleet's host goes without a reply (`--re`) before a manager's watch tells, read or not (default 600 s) |
| `FLEET_NUDGE_S` | chat.py | how long a message to a worker waits unanswered before the coordinator's watch tells (default 600 s, L1) |
| `FLEET_WATCH_SETTLE` | chat.py | how long a `--once` watch waits after a new line for more before it exits (default 30 s; `--settle` wins) |
| `FLEET_WATCH_SETTLE_USER` | chat.py | the same after the user's message to WHO (default 10 s, never more than the settle) |
| `FLEET_WATCH_SETTLE_MAX` | chat.py | the longest a `--once` watch holds its first new line (default 120 s) |
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

**agent** `ID [--task T --milestone M] [--skill implement|diagnosing-bugs|prototype|research|tdd|none] [--model opus|sonnet|haiku|fable] [--effort low|medium|high|xhigh|max] [--lane PATH...] [--status queued|running|blocked|done|failed|stopped] [--tokens N] [--duration-ms N] [--task-id ID] [--report R] [--brief B] [--name N] [--step S] [--log TEXT] [--important]`
- `--milestone`, when given, must be known: `unknown milestone 'M' (the roadmap has: m1, m2)`.
- New: needs `--milestone` and `--task`. Defaults: name = id, skill none, model and effort by the
  [role table](#the-role-table) (research: sonnet medium; any other skill: opus high), status
  running, lane [], tokens 0, duration_ms 0, rounds 1, brief "", report "", `started` = `updated`
  = now; `task_id` when given; `name_by: "coordinator"` (after `task_id`) when `--name` is given. Logs `spawned` (`--log`, else `Spawned on <model> following <skill>.`).
  `--step S` marks S current with this agent (unknown S refused). Prints
  `recorded ID (NAME); its brief opens with: Read DIR/brief.md first; your id is ID.`
- Known: status `done` → `running` adds a round. `--task-id` sets it and forgets `measured`.
  `--name N` sets the name and `name_by: "coordinator"`; `--name ""` puts the id back and drops
  `name_by`, so the worker's session names it again (below). The other fields given are set; `--tokens` or `--duration-ms` set `measured: "by hand"`, after which the
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
- A (model, effort) pair outside the role table is recorded and warned about, see [Warnings](#warnings)
  (L3), on an `agent` command that gives `--model` or `--effort`. Every model `--model` takes is in the
  table (haiku since 2026-10-08); a model outside it, which only a hand-written row can have, is warned
  about by name. The page shows the effort beside the model and marks a model outside the table.
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
- **Names.** A worker is called, first found of: the name the user gave on the page (`name_by:
  "user"`, the hub's `POST /f/<fleet>/name`); the coordinator's `--name` (`"coordinator"`); what its
  session calls it (`"session"`): its subagent's `subagents/agent-<task_id>.meta.json`, `name` (the Agent
  tool's) else `description`, beside the transcript of DIR's scratchpad's session, else of the fleet's
  registered `session_id` (a fleet served outside a scratchpad, a respawned session); its id (`name_by`
  absent). The name is resolved when it is written, not
  by the page: on every write (after measuring) each row with a `task_id` that nobody named (`name_by`
  absent with the name its id, or `"session"`) takes its session's name, unless a mention could not
  tell it apart (a chat participant's, or another worker's id or name, case-insensitively: then it
  keeps its name). A row from before `name_by` whose name is not its id counts as the coordinator's.
  Nothing automatic replaces a user's or a coordinator's name (*TypeScript only, out of the oracle,
  which has no subagent files; pinned by fleet/test/naming.test.ts*).
- **The lock.** `fleet state` reads, changes and writes `state.json` (and renders) under an exclusive
  `flock` of `DIR/state.json` itself, which the hub's rename takes too, so neither loses the other's
  change; `init`, with no ledger yet, takes none. `state.json` is written in place, so the lock
  outlives each write and no lock file joins DIR (*TypeScript only; Python's state.py takes none*).
  `fleet ws` and `fleet preview` write the ledger without it.

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

**decision** `ID [--kind decision|input|secret|action|notice --title T --question Q --why W] [--blocking | --not-blocking] [--option "KEY: label | consequence"]... [--same-options] [--recommend R --reason WHY] [--secret NAME] [--manual TEXT] [--body FILE | --no-body] [--agent A] [--supersedes ID] [--step S] [--milestone M] [--log TEXT] [--asks user|manager] [--advised VIEW] [--under APPROVAL --undo HOW] [--decide ANSWER --resolution HOW | --withdraw REASON | --hold REASON | --unhold]`

Checked in this order:
1. `--decide` without `--resolution`: refused.
2. `--agent` must be a worker row (in a manager's ledger, any name).
3. A closed decision (decided or withdrawn) refuses every change (`<title> is already <status>:
   <resolution>. A closed decision stays as it is; open a new one with --supersedes ID`) except
   `--step` and/or `--milestone` alone, which set where it came from.
3a. **A notice** (`--kind notice`, `--under` or `--undo` given): an act done under a standing approval
   (see **approval**), recorded closed at once. Checked in this order: a known id is refused (`<id> is
   already a <kind>: a notice is recorded once, under a new id (...)`; a closed one was refused in 3);
   `--under`/`--undo` without `--kind notice` (`--under and --undo record a notice: give --kind notice`);
   the id pattern; any of `--option`, `--recommend`, `--reason`, `--secret`, `--manual`, `--supersedes`,
   `--decide`, `--withdraw`, `--hold`, `--advised`, `--asks manager`, `--blocking` given (`a notice reports
   what was done under a standing approval and asks nothing: leave out --option, ...`, in that order); then
   `new notice needs --title --question --under --undo` for those missing; an unknown approval (`unknown
   approval 'K9': \`approval list\` shows ...`) or a revoked one (`approval K1 was revoked <when>: <why>.
   What it covered asks the user again: open a decision`); an approval whose source no longer grants,
   checked again as `approval add` checks its `--ref` (`ref`, and `:Q<n>` for its `question`), a fleet no
   longer served read from its entry kept in `REGISTRY/names/` (`approval K1 no longer stands: <why>. What it
   covered asks the user again: revoke it (approval revoke K1 --reason "...") and open a decision`); a blank `--undo`; the question's and the why's
   lengths as in 4. The row is a decision's with `kind` notice, `status` decided, `answer` "done",
   `resolution` "under <approval>", `closed` = `opened`, `asks` user, `page` true, no options, plus `under`
   (the approval's id) and `undo`; `--why`, `--agent`, `--step`, `--milestone` and `--body` as for a
   decision. Logs `decision` (`Done under K1 (<rule>): <title>: <question>`, not important, tagged), prints
   `recorded <id>, done under K1 and closed: ...`, and once `state.json` is written posts a news item to
   the manager (`<fleet> did under standing approval K1 (<rule>): <title>. <question> Undo: <undo>`, cut to
   1000 characters with `…`; kind fyi, `--to` the manager's name, not kept) from the fleet's registry name, else its project's
   name with every run of characters outside `[A-Za-z0-9_.-]` made one `-` (`fleet` when none is left),
   and prints `news #N tells the manager (fyi).` The manager is the first registry entry, by file name,
   whose role is manager and whose pid runs, read without pruning; with none (or when it is the sender)
   nothing is posted and it prints `no manager is served: no news item (the fleet's page lists the
   notice).` No readability warning applies.
   Otherwise, **`--advised`** given (new or known) must not be blank, nor `none:` with nothing after it:
   `--advised is the advisor's view in one line, or none:<why no advisor was asked>`.
4. New: the id must match `[A-Za-z0-9_.-]+`. `--supersedes` must name a closed decision (an open
   one: `<title> is still open; change it instead of superseding it`) and is stored as its id.
   - **The question's length** (new, and on a known one whenever `--question` is given; the
     length is in characters, code points): over 400 is refused, checked right after the required
     fields (`--question is N characters, M over the 400 a question holds: keep the ask, one or two
     plain sentences, and move the plan, the settings and the numbers into --body FILE (an HTML
     fragment: In short, What you're deciding, The plan, Settings, Cost and risk, How to undo, What
     happens after you answer)`). A permission's question (the effective kind is permission) is not
     checked. A stored question over the limit is kept: only a write is checked.
   - **The why's length**, the same way, right after the question's: a `--why` over 400 characters
     is refused (`--why is N characters, M over the 400 a why holds: say in one or two lines what the
     fleet does meanwhile, or why this needs the user, and move the plan, its parts and the cost into
     --body FILE`), on a new decision, a revision that gives it, and a new grilling; not a permission's.
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
     user), opened, revised, closed, step, milestone`, and `advised` when given. `--step S` sets step and its milestone;
     `--milestone M` sets the milestone; a worker without either gives its own milestone.
   - `--body FILE` copies FILE to `DIR/decisions/<id>.html` and sets `body` (an unreadable FILE
     is refused).
   - **The advisor's view** (after the readability warnings below): a decision or input that asks the
     user, open, with no `advised`, is warned: when the ledger has a live (running, queued, blocked) row
     `advisor`, `state: <id> asks the user with no --advised: ask the fleet's advisor first (SendMessage),
     then give its view in one line (--advised "..."), or --advised none:<why not>; the page shows it under
     the recommendation.`; else when it is choice N >= 3 of the day (decisions, inputs and grillings with
     asks user and page true whose `opened` has today's date, the first ten characters of the stamp, this
     one counted), `state: <id> is choice N this fleet asks the user today, and no advisor runs: start one
     (\`FLEET advisor DIR\`) and ask it first, then give its view (--advised "..."), or --advised none:<why
     not>.` The same on a known one that `--asks user` passes on from the manager.
   - Logs `asked` (`<title>: <question>`, prefixed `For the manager: ` when asks is manager),
     important when blocking and not for the manager, tagged with the decision. Prints
     `asked <id>. Arm its answer's wake now, as a background command (run_in_background):
     \`FLEET chat DIR wait <id>\`: it exits with the user's answer the moment it is given.`
5. Known and open: `--supersedes` is refused. A new `--question` for a choice needs its options
   again (`--option`) or `--same-options`; then the question's length is checked as in 4. The fields given are set (an empty value clears);
   `--option` replaces all options; `--blocking`/`--not-blocking`; `--asks` changes who looks
   first; the kind check runs on the result; `--body`/`--no-body` (the latter deletes the file).
   When anything changed, `revised` = now, `change` = `--log`, and an `asked` event is logged:
   `<title> now asks you: <question>` (important when blocking) when `--asks user` passes a
   manager's decision on, else `<title> changed: <--log, or the fields whose value moved (body,
   asks and a permission's refusal count as moved when given), or "nothing new (the same values
   given again)">`. A revision
   that gives `--question`, `--option` or `--manual` re-presents the item: it clears a hold.
   **Warnings** on stderr, the write done, after the kind check and the body (new or known, not
   for a permission or a grilling), in this order, each only for a field this command gave:
   `state: <id>'s question is N characters and it has no --body: ...` (question over 300, no
   body); `state: <id>'s question uses words the user may not know (sha1, alias): ...` (whole
   words, any case, from sha1, sha256, digest, stage cache, alias, uuid, idempotent, upsert, blob,
   enum, turn gate, gold, harness, rubric, jev, listed in that order); `state: <id> names workers
   (b333, invoice-gen): say what the work is (...); a worker's id or name means nothing to the user.`
   (a word of letters, digits, `_` and `-` that is, any case, the id or name of an agent row of the
   ledger, each once in the order found, in the title, then the question, then the reason, of those
   given; a decision's number or id such as D40, g26 or p12 is not one unless a worker has it); `state: <id>'s why is N characters: ...` (over 200); `state:
   <id>'s consequences over 160 characters: A (212), ... ` (`--option`); `state: <id>'s manual has
   bash in a nu block (&&, export X=, $(...), 2>&1): ...` (`--manual`, the patterns found in its nu
   blocks, in that order); when the question, why or body was given, `state: <id> refers to what the
   user decided ("you decided", "your rule") with no decision number: name it in the same sentence,
   its number, when, and what was chosen (...); the page links the number.` for each phrase (you
   decided, you said, you chose, your rule, as decided, you approved; any case; each once, lower-cased,
   in the order found) in a sentence of the question, why or body text (tags taken out; a sentence ends
   at `.`, `!` or `?` and a space, or a line break) that holds no `D`, `A`, `I` or `G` and digits as a
   word, any case (a fleet's id such as `d172` counts); then, for a choice (kind decision) whose question, why or body this command gave,
   `state: <id> looks like it needs a visual (graph, database; 3 amounts to compare): see coordinator
   SKILL.md #decisions (show-me triggers): a small inline SVG of the parts, a table of the numbers, in
   --body.` when its question, why and body text (tags taken out) name database, graph, neo4j,
   postgres, pipeline, stored in, lives in or queue (whole words, any case, a plural too; each once,
   lower-cased, in the order found) or carry three or more amounts (`US$7`, `R$ 3`, `$5`, `€2`, `12%`),
   and its body has no `<svg`, `<table` or `<img`; then, on a known one, `state: <id> was asked again with new words and
   no --log: ...` when `--question`, `--option` or `--manual` was given with no `--log`,
   `--decide` or `--withdraw`.
   **A nu block that does not parse**: a secret's or action's `--manual` given in this command,
   checked after the fence rule: each fenced block tagged `nu` or `nushell` (an unclosed fence runs
   to the end) is piped to `nu --no-config-file --stdin -c '$in | nu-check --debug'` when `nu` is
   on PATH (20 s at most; no nu, a timeout or a failure to start skips the check). A non-zero exit
   is refused: `--manual's nu block N does not parse in nushell (nu-check --debug: <the last
   "Found : " line of nu's output, else "a parse error">): write it so it runs in Luiz's shell, or
   tag the block with the language it is in`.
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
6. **A failed action**: the page answers an action the user ran and that failed with
   `Failed: <what happened>`. The open action's latest answer from the user since it was opened or
   last revised, when it begins `Failed:`, makes it failed, whatever replies or hold came after
   (`failedAnswer`, `decisions.failed_answer`). While it is failed, `--decide` is refused, checked
   after the revision in 5 (`<title> failed for the user (#N: <first words>) and is not done: revise it
   with a fix and re-present it (--manual, --question), or --withdraw "why"`); a revision (the fix,
   re-presented) or `--withdraw` settles it, and a later answer that does not begin `Failed:` makes it an
   ordinary answer again. The first words are the note's first line, cut at 60 characters with `…`.
   `show` adds `, failed for the user (#N: <first words>)` to its status. Only the chat says it: the
   ledger holds no copy.
7. `--decide ANSWER --resolution HOW` closes it decided: logs `decision`
   (`<title>: <answer> (<resolution>)`). `--withdraw REASON` closes it withdrawn: logs `resolved`
   (`<title> withdrawn: <reason>`). Either sets `closed` = now, removes a hold, and resolves every
   open roadblock waiting on it (each logging its own `resolved`, and unblocking its worker).
8. Validation: ids unique; no id equal to another decision's number; `supersedes` and
   roadblocks' `decision` name existing ids; defaults are filled (`asks` user, `blocking` false,
   `page` true, `body` false, the optional fields null, a grilling's `questions` []). `held` and
   `held_at` are present only on a held decision, both strings (`decision X is held without its
   reason and when (held, held_at)`), and only on an open one (`decision X is <status> and still
   held`); no default fills them.

**grill** `ID [--title T --why W --log TEXT] [--ask "TITLE | QUESTION | RECOMMENDATION | WHY"]... [--of Q] [--option "Q1 a: label | consequence"]... [--body FILE | --no-body] [--answer "Q3: ..."]... [--drop "Q4: why"]... [--revise "Q3: T | Q | R | W"]... [--reason "Q3: why"]... [--blocking] [--agent A] [--step S] [--milestone M] [--done SUMMARY]`
- A known ID that is not a grilling: `X is a <kind>, not a grilling`. A closed one is refused.
- `--why` over 400 characters is refused as a decision's is, new or known.
- New: needs `--title` and at least one `--ask`; a decision row of kind grill, `question` "",
  `page` true, `questions` [].
- Known and open: `--title` and `--why` revise the grilling itself, each only when its value moves
  (an empty `--why` clears it; an empty or blank `--title` is refused: `--title is empty: a grilling
  keeps a title`), checked before the questions.
- Applied in order: answers (`status` answered, `answered` = now), drops (dropped, `answer` null,
  `dropped` = reason), revisions (back to open with new words, `asked` = now), reasons, then new
  questions `q<n+1>` (`of` = `--of`, lower-cased; `--of` must name a question). A `Q<n>` that
  doesn't exist is refused, as is text without the `Q3:` head. `--ask` needs four non-empty parts.
- Then options: each `--option "Q<n> <key>: label | consequence"` (key as a decision's option id, label
  and consequence non-empty, else `--option reads "Q1 a: label | consequence", got '<text>'`) names a
  question, the new ones of this command included (`--option Q9: no question Q9 in <id>`), that is open
  (`--option Q1: Q1 is answered; options are for an open question`); a key twice for one question is
  refused (`Q1's option 'a' is given twice`), as is a question given one option (`Q1 has one option: give
  at least two (--option "Q1 a: label | consequence", once per option)`). The options given for a question
  replace its `options` (a key added at the end of the question when it had none; a question asked
  without them has no `options` key). Then each question asked, revised or given options in this command
  that has options must recommend one of them by its id, exactly (`Q2's recommendation '(a)' is not one
  of its options (a, b): recommend by the option's id`). A revision keeps the options unless given again.
- Then the body: `--body FILE` copies FILE to `DIR/decisions/<id>.html` and sets `body` true, `--no-body`
  deletes it and sets false, as for a decision (one of the two, else exit 2): the context every question
  shares, which the page shows once above the first question, as "The context".
- `question` becomes `N question(s) to answer` or `Every question is answered`.
- A question asked or revised whose QUESTION part is over 300 characters is warned, never refused,
  once the round is taken, revisions first then new questions, in the order given: `state: <id>'s
  Q<n> is N characters: ask it in one plain sentence, its choices as --option; the evidence goes in
  --body.` Then, for each question in order, warned, never refused: a worker's id in its title and
  question (asked or revised in this command) and its reason (as below), as for a decision (`state:
  <id>'s Q<n> names workers (b333): ...`); its reason (asked, revised or given
  with `--reason` in this command) over 200 characters (`state: <id>'s Q<n> reason is N characters: say
  the trade-off in one plain sentence (over 200 is hard to read on a phone); the evidence goes in
  --body.`); the sources in its reason's first sentence (up to the first `.`, `!` or `?` and a space): a
  path with a line (`store.ts:5-9`), `ADR-0024`, a decision's number (`D27`), each once in the order
  found (`state: <id>'s Q<n> reason opens with sources (ADR-0024, store.ts:5-9): say the trade-off in
  plain words first; files, lines, ADRs and decision numbers go after it, or in --body.`); and of its
  options (asked, revised or given options in this command) the consequences over 160 characters
  (`state: <id>'s Q<n> consequences over 160 characters: b (162). Say each in one line; the detail goes
  in --body.`) and more than four (`state: <id>'s Q<n> has 5 options: give 2 to 4; a choice the user
  makes on its own is a question of its own.`). Then, when questions were asked or revised or `--why`
  or `--body` given, the past-answer warning as for a decision, on the grilling's why, the QUESTION and
  WHY parts asked or revised in this command, and its body; then the show-me warning, on its why, the
  QUESTION parts asked or revised in this command, and its body.
- New questions, revisions, options, reasons, a body, or a moved title or why log `asked`
  (`<title>: N new question(s)` / `a question revised` / `options given` / `reasons added`, else what
  of the grilling moved, `the title changed, the why changed, the context changed` as applies;
  `<title>: <--log>` instead when `--log` is given), important when blocking; on a known grilling
  they stamp `revised` and set `change` to `--log` (null without it), and new questions or revisions
  clear a hold. The first round prints the `wait` line.
- `--done SUMMARY` needs no open question (`Q2, Q3 still open: answer them, drop them, or ask
  what is left`) and closes it decided with resolution `grilling finished`.
- **Answered, waiting to be recorded**: an open grilling with no question left open (every one
  answered or dropped). One rule (`answeredGrill`, fleet/src/health.ts; `decisions.answered_grill`),
  read from the questions' statuses whatever the chat said since: `show` reads `OPEN, answered,
  waiting to be recorded`, every state command warns ([warning 4](#warnings)), the coordinator's
  watch and the mid-turn nudge say it, and the page (`grillState`'s `answered`, by the same rule)
  lists it under Waiting with the pill `answered, waiting to be recorded` and a note on its page,
  until `--done`, `--decide` or `--withdraw` closes it.
  A question answered (`--answer`), dropped or revised, and a grilling withdrawn (`decision ID --withdraw`),
  revoke every active approval of this ledger that came from it (its `ref` the grilling's id, or
  `<name>/<its number>` for a name the registry gives this DIR; a question's, that question's): each is
  set `revoked` with `revoked_why` `G2:Q2 was answered again (<answer>)`, `... was dropped (<why>)`, `... was
  revised` or `G2 was withdrawn (<reason>)`, logs `decision` (`Standing approval K1 revoked: <why>`) and prints
  `revoked approval K1 (from <ref>:Q2): <why>; what it covered asks the user again.` A copy in another
  fleet's ledger is refused at use instead (a notice, above).

**event** `[--agent A] [--kind spawned|reported|blocked|resolved|asked|decision|note|integrated|reviewed] [--important] [--findings N --changes C,...] TEXT`:
logs one event (kind note by default). `--agent` must be a worker row (a manager's: any name). Kind
**reviewed** (a review of a stack before it lands; `land-check` reads it) needs `--findings` (an int, 0 or
more) and `--changes` (jj change ids, letters and digits, split on commas and whitespace), stored on the
event as `findings` and `changes` after `text`; refused without them (`a reviewed event says what the
review found and of which changes: ...`), with a negative count, or a change id with another character. On
any other kind, `--findings` or `--changes` is refused (`--findings and --changes go with --kind reviewed`).

**approval** `ACTION [ID] [--rule R --by WHO --ref [FLEET/]DECISION[:Q<n>]] [--reason R]`: the standing approvals,
`approvals[]` (created on the first). ACTION outside add, list, revoke is refused (`approval 'x' is not one
of add, list, revoke`). `list` prints one line per approval (as `show` does, below; `no standing approvals:
...` when none) and writes nothing. `add` and `revoke` need ID (`approval add names the approval: ...`).
- `add`: a known ID is refused (`approval K1 is already recorded (<status>): ...`); then an ID other than K
  and ASCII digits (`an approval's id is K and a number (K1, K2, ...), not 'A1': the other letters number
  decisions, links and roadblocks`);
  `new approval needs --rule --by --ref`; a blank rule or by. Then `--ref` (`approval_source` in
  decisions.py, `approvalSource` in fleet/src/ledger/approvals.ts), in this order: it reads
  `[FLEET/]DECISION[:Q<n>]` (`--ref reads [FLEET/]DECISION[:Q<n>] (D7, manager/G5:Q1), got 'x'`); FLEET,
  when given, is a fleet the registry serves, by its id, else an alias, read without touching the registry
  (`no fleet 'x' is being served: ...`), and its `state.json` is the ledger read (`fleet 'x' has no ledger
  at <path>`), its `chat.jsonl` the chat; DECISION (an id or a number) must be known there (`unknown
  decision 'G9'`, ` in <fleet>` added for another fleet's). It is named `<label> (<title>)`, the label its
  number (`D1`, `manager/G5`). `:Q<n>` names a grilling's question: refused on another kind (`manager/D5
  (<title>) is a decision, not a grilling: :Q2 names a grilling's question`), and a grilling needs one
  (`... is a grilling: name the question the user answered yes or approve (manager/G5:Q1)`). A withdrawn
  decision refuses (`manager/G5 (<title>) was withdrawn: a standing approval comes from a decision that
  stands`), and so does one another decision of its ledger supersedes (`... is superseded by D3: ...`). Then a choice
  or input must be `decided` (`D1 (<title>) is open: a standing approval comes from a decision the user
  decided`); a grilling's status is not read, only its question's, so a question answered while another is
  still open grants. It must be of kind decision, input or grill, asks user and page true (`... was not
  asked of the user on the page: ...`); the question must exist (`... has no question Q9`), be answered
  (`manager/G5:Q2 is open, not answered yet: ...`) and answered with a plain yes: the whole answer, trimmed, in lower case, its trailing full stops and
  exclamation marks dropped, is one of yes, y, approve, approved, sim, ok, after an option key (`(b)`, `b:`,
  alone or followed by that option's label only) is read as that option's label, "as recommended" or the
  page's "ok, as recommended (X)" as the question's recommendation, and a trailing "(as recommended)" is
  dropped; anything after it is a qualifier and refuses (`manager/G5:Q2 was answered '(b) no': only a plain
  yes (yes, approve, sim, ok) gives a standing approval; ask the user again for a plain yes or no, one rule
  to a question`). Then the user's own words, from that fleet's chat (only the hub writes as the user; a
  coordinator's or the manager's relay is not one): for a question, the last `Q<n>: ...` line (with the
  lines under it that are no question's) of a user message tagged with the grilling, else a user message
  whose `re` is a message naming that question alone, its `at` not older than the question's `asked` (its
  last asking or revision) (`manager/G5:Q2 has no answer from the user in the chat since it was last asked
  (<asked>): ...`), and it must be a plain yes too (`manager/G5:Q2: the user's own answer in the chat (#14) is
  'no', not a plain yes: ...`); for a decision or input, the latest user message tagged with it (`... has
  no answer from the user in the chat: ...`), then the decision's `answer` must be a plain yes, or with options name
  the option that says one (`D1 (<title>) was decided 'B', not a plain yes: ...`), and the user's message
  must pick that same option, or for an input say a plain yes, with nothing after it (`D1 (<title>): the
  user's own answer in the chat (#3) is 'B: no', not a plain yes: ...`). Last, no revoked approval of this
  ledger may come from that same source (`D1 backed approval K1, revoked (<when>): a revoked approval's answer
  gives no new one; ask the user again`). The row: `{id, rule, by, ref,
  question? ("q2"), message (the id of the user's message that answered), author (its author, when it has
  one), added, status: "active"}`, `ref` the decision's id here, or `<fleet>/<its number>` for
  another fleet's. Logs `decision` (`Standing approval K1 from manager/G5:Q1 (#14): <rule>`, tagged with
  the decision only when it is this fleet's) and prints how to record a notice under it.
- `revoke`: an unknown ID, a revoked one (`approval K1 is already revoked (<when>): <why>`) and a blank
  `--reason` are refused. Sets `status` revoked, `revoked` = now, `revoked_why`; logs `decision`
  (`Standing approval K1 revoked: <reason>`, tagged with its decision when it is this fleet's).
- Validation: `approvals`, when present, is a list of objects with non-empty strings `id, rule, by, ref,
  added, status` (`approval X needs id, rule, by, ref, added and status`), ids K and digits (`approval id
  'A1' should be K and a number`) and unique, `status` active or revoked, `ref` naming a decision of
  this ledger or, with a `/`, `FLEET/DECISION` (`approval K1 comes from 'x/': another fleet's decision is
  FLEET/DECISION`), `question`, when present, q and digits; a notice's `under` names an approval
  (`notice X is done under unknown approval 'K9'`) and its `undo` is not blank. Checked after the
  roadblocks' decisions.

**park** `[--agent A]... REASON`: every live row (running, queued, blocked), or only the named
ones, becomes stopped with `updated` = now; each current step of a stopped worker goes back to
pending, keeping its agent (open-5, fixed); one note event, `Stopped a1, a2: REASON`. A named
worker without a row is refused; no live row among them: `no worker row is running, queued, or
blocked`.

**keep** `ID [TEXT | --drop REASON]`: `kept[]` (created on first use) holds `{id, text, at}`. TEXT
creates or rewrites; `--drop` removes it and logs `Dropped ID (<text>): REASON`; dropping an
unknown one and TEXT missing are refused.

**link** `ID [--url U --title T] [--kind preview|prototype|doc|tool|service|dev|page] [--for WHAT] [--decision D] [--agent A] [--note N] [--done | --reopen] | --drop REASON`:
`links[]` (created on first use). `--drop` removes a known one (logs `Link ID (<title>) removed:
REASON`). `--decision` must name a decision, of any status, stored as its id; `--agent` must be
known. New: needs url and title, `since` = now, `for` = `--for` or null, logs `<Kind> <title>: <url>`
(`Preview`, `Prototype`, `Doc`, `Tool`, `Service`, by the kind it reads as) tagged with agent and decision. A
new link without `--kind` is stored with the kind its address reads as ([Link kinds](#link-kinds)) and
warned: `state: link ID has no --kind: recorded as <kind>. Say which it is: preview, prototype, doc, tool,
service (the preview is the fleet's one live app).` Known: fields given are set (an emptied one null).
`--done` stamps `done` = now and logs `Link ID (<title>) done`; `--reopen` removes it and logs `Link ID
(<title>) open again` (only when it was done); either on an unknown link is refused (`no link 'ID' to mark
done`, `... to mark open again`), and the two together exit 2. A title (new or given) that names a worker's id or
name as the ledger records it is warned, as a decision's is: `state: link ID's title names workers (b286):
...`. `dev` and `page` stay accepted for the rows recorded before the five.

### Link kinds

What a link is to the user (`links.py`, `fleet/src/ledger/links.ts`): `preview` (the fleet's live
preview of the app: one per fleet), `prototype` (a throwaway sketch or round), `doc` (a design note, a
report, an artifact), `tool` (a page the user works in: marking, confirming gold), `service` (a lab or
infra endpoint). A stored kind that is not one of the five (`dev`, `page`, missing) is read at display
time, never rewritten: a claude.ai artifact (`https://claude.ai/artifact/…`, `/code/artifact/…`) is a doc;
an address with `/prototipo`, `/protótipo` or `prototype` in it, or a title that says prototype or
protótipo, is a prototype; else `page` and a `file:` address read as doc and the rest as preview. `show`,
`fleets list` and the view use the kind as read; `show` adds `, done` and `(for: …)`.

A link's **reach**: `machine` when its scheme is http(s) and its host is this machine or its tailnet
(`localhost`, `*.localhost`, 127/8, `::1`, `0.0.0.0`, `*.ts.net`, 100.64/10), `file` for `file://`, else
`external` (never probed). The TypeScript fleet reads the host as fetch will (WHATWG `new URL`: `0127.0.0.1`
is 87.0.0.1, so elsewhere), and an address with userinfo (`user@`) or a backslash is `external`. In the hub,
`*.ts.net` is only this machine's own tailnet suffix (`MagicDNSSuffix` from `tailscale status --json`, else
its name without the first label), read once at its start; none read, no `*.ts.net` name is this machine's.
The CLI's render and the Python twin take any `*.ts.net`.

**In the view** (`fleets.view`, the page's state), each link carries, beside its row and `fleet`: `kind` as
read, `reach`, `up`, `file` and `decision_status` (the status of the decision it serves, found by id then
number, or null). `up`: a `machine` link's TCP probe of 127.0.0.1 at its port (the hub's: below); a `file`
link's file is there; an `external` link's is false. `file`: for a `file` link under the fleet's files root
with no dot part, the hub path `files/<path, its parts URI-encoded>`, prefixed `f/<fleet>/` on the manager's
page for another fleet's; else null. The hub's view replaces a `machine` link's probe with an HTTP one and
adds `checked` and `state_since` (stamps, null until its first probe ends): a HEAD of the address (a GET of
`bytes=0-0` on 405 or 501), 3 s, redirects never followed, no credentials, a loopback address's certificate
not checked; up unless it fails, times out, or answers 502, 503 or 504 (`tailscale serve` before a stopped
server). `up` is null (unknown) until its first probe ends, and when the probe itself fails (throws or
rejects). Each address's answer is held 60 s of the hub's clock and probed again in the background, at most
512 addresses held (the least recently asked dropped first); `state_since` is when it last turned up, down or
unknown. The page counts a link inactive when it is done, its decision is decided or withdrawn, a `machine`
link is down, or a `file` link's file is gone; an unknown one stays active and its row says "checking…". One
that serves an open decision or says `for` waits on the user.

**show**: prints the ledger and the command cheat sheet; writes nothing. Pinned lines:
`<project> [<status>(, manager)(, shared working copy)] <now>`; per milestone `  <id> <title> (<done>/<steps>)` and
per step `    <id:<6> <status:<8> <title>( @agent)`; per worker
`  agent <id:<16> <status:<8> <skill:<15> <model:<6> <effort or -:<6> <tokens:>8> tok  lane=<a,b or ->( round N)`;
per roadblock, decision, link, approval (`  approval <id> <active | revoked <when>: <why>> [N notice(s)] <rule>
(from <the decision's number> #<message>, by <by>, <added>)`) and kept note a line, with its number where
it has one; then
`  <N> events, updated <updated>` and the cheat sheet. The cheat sheet lists each command with
the values its flags take.

### The role table

`ROLES` in state.py and `fleet/src/ledger/roles.ts`, the one place each stack holds these values (the
oracle's model reads state.py's), so a new table is one edit in each and re-recorded traces:

| | haiku | sonnet | opus | fable |
| :-- | :-- | :-- | :-- | :-- |
| pairs the policy approves | low, high | low, medium, high | medium, high | high |
| a new worker's, by skill | | research: medium | any other skill: high | `fleet advisor`'s row: high |
| a model given alone takes | high | medium | high | high |

`xhigh` and `max` are in no pair: both warn on every model. A new row given neither `--model` nor `--effort` takes its kind's pair; given an
effort only, its kind's model; given a model only, its kind's effort when that pair is approved, else the
model's own (`alone`). A known row changes only the fields given: a
new `--model` leaves the effort as it was. A row recorded before efforts has no `effort` key; nothing
fills it (validation fills `model`, not `effort`), `show` prints `-`, `fleet brief` names no effort, and
the policy judges it by its model alone. The ledger has no marker for a monitor or watcher row, so no
kind gives one (sonnet low is approved when given).

## The ledger: state.json

Every list is in the order the user reads it. Stamps are `clock.stamp()`.

```
role          "manager" in a manager's ledger, absent in a coordinator's
project, goal, status (running|paused|blocked|done), now, now_at, started, updated
roadmap[]     {id, title, steps[]: {id, title, status (done|current|pending|blocked), agent|null}}
agents[]      {id, name, task, skill, model, effort? (low|medium|high|xhigh|max; absent on older rows),
               status (queued|running|blocked|done|failed|stopped),
               lane[], milestone, tokens, duration_ms, rounds, started, updated, brief, report,
               task_id?, measured? ("by hand" | the transcript's mtime),
               name_by? ("user" | "coordinator" | "session"; absent: the name is the id)}
               in spawn order: the page colours by position, so rows are appended, never reordered
roadblocks[]  {id, title, detail, agent|null, severity, needs, decision|null, since, resolved, ref}
decisions[]   {id, ref, kind, title, question, why, blocking, agent, options[]: {id, label, consequence},
               recommend, reason, secret, manual, body, page, supersedes, status (open|decided|withdrawn),
               answer, resolution, change, asks (user|manager), opened, revised, closed, step, milestone,
               questions[]? (grill: {id: "q<n>", title, body, recommend, reason, of, status
               (open|answered|dropped), answer, asked, answered?, dropped?,
               options[]?: {id, label, consequence}}),
               held?, held_at? (the fleet works on the answer first; removed when re-presented or closed),
               refusal? (permission, TypeScript only: {tool, call, rule, cause, root, agent_id}),
               advised? (the advisor's view, or none:<why>), under?, undo? (a notice's)}
approvals[]?  {id, rule, by, ref (a decision id, or FLEET/<number> in another fleet's ledger), question? (q<n>),
               message?, author?, added, status (active|revoked),
               revoked?, revoked_why?}
events[]      {at, agent|null, kind, text, important?: true, decision?, findings?, changes?}   append-only
links[]?      {id, ref, url, title, kind (preview|prototype|doc|tool|service; dev|page before them), decision, agent, note,
               for (what the user does there, or null), since, done? (when the fleet marked it done)}
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
kind (decision **D**, action **A**, input **I**, secret **S**, grill **G**, notice **N**, permission **P**
(TypeScript only), link **L**, roadblock **R**), and 1 + the highest number of that letter already given, skipping a number that another row of
the same list has as its id (open-1). A standing approval is numbered **K** by its own id, which `approval add` takes
only as K and digits. Decisions are numbered in
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
   leaves whose answer the user gave on the page and the decision has not recorded (`answerRecorded`,
   Python's `decisions.recorded`): given after it was opened or last revised (instants), after `held_at`
   when it is held, and, on a grilling, after its last question answered or dropped. Only the decision's
   own state records an answer: a reply in the chat does not record an answer; only the decision command
   does (D115 sat two days under `fleets waiting` behind a "Recorded B" reply). Closed, it has recorded
   every answer. Not for `init`. A
   grilling answered and waiting to be recorded (see `grill`) gets its own line instead, whatever
   the chat said after its last answer (a reply, a recap, amendments): `state: every question of G6
   (<title>) is answered and the grilling is still open; record it before any other work: \`fleet
   state <dir> decision G6 --decide "..." --resolution "grilling finished"\`, or --withdraw "why".`
   A failed action (see `decision` 6) gets its own line instead, until it is revised, withdrawn, or
   held after the failed answer, a reply notwithstanding: `state: the user ran A1 (<title>) and it
   failed, #14 at 09:12: <first words>. It is not done: fix what failed and re-present it (\`fleet
   state <dir> decision A1 --manual "..." --log "what changed"\`), or \`--withdraw "why"\`; never
   --decide it. Answer #14 with --re.`
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
7. **A pair outside the role table** (`state: a1 is recorded on opus at low effort, outside the effort
   policy (opus medium, high; sonnet low, medium, high; fable high; haiku low, high): spawning it so needs
   the user's OK.`), or, on a hand-written row, **a model outside it** (`state: a1 is recorded on gpt,
   outside the model policy (opus, sonnet, fable, haiku): spawning it on gpt needs the user's OK.`), on an `agent` command
   that gives `--model` or `--effort`, judged on the row as the command leaves it (L3). A row with no
   effort is judged by its model alone.
8. *TypeScript only* (Python's ledger has no `workspaces`, and no trace does): **a done worker's
   workspace not pruned** (`state: a1's workspace a1 still there though its worker is done: bring its
   changes into the stack, then prune it (\`fleet ws <dir> prune\`, a dry run, then --apply), or hand it
   to the next worker of its lane (\`fleet ws <dir> add <next> --reuse a1\`).`), naming both ways out, on every command,
   and on `set --status done` **the workspaces left** (`state: the fleet is done with workspace(s) a1
   not pruned: ...`).
9. **Unread news** (`news: N unread for <fleet>, never a wake: \`fleet news read --as <fleet>\``), one line,
   last, when the machine's news holds items the fleet has not read ([The news](#the-news-fleet-news)).
   Not for `init`. Read only when `REGISTRY/news/news.jsonl` exists, and the fleet's name is read from the
   registry's entries without pruning or renaming any.

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
login, set only by the server), `decision`, `quote {text ≤2000, from ≤200, at?}`, `marks` (a batch of
marks on a decision's body, TypeScript only: [Marks on a decision](#marks-on-a-decision-typescript-only)),
`mark [N, ...]` (on an answer, the marks of the batch `re` names that it answers, TypeScript only), `side`
(the id of the message that opened a side chat), and, written by the hub only (its Delivery, in [The hub](#the-hub-fleet-hub)),
`delivered [{fleet, id}]` (on the manager's message: the coordinators that have it in their own chat, and
its id there), `via {fleet, id}` (on that copy, `{fleet: "manager", id}`, and on a coordinator's answer
mirrored onto the manager's page, `{fleet, id}` of the answer) and `origin` (the `Origin` of a prototype
page the user posted from, one the hub's config allows: [Posting from a prototype page](#posting-from-a-prototype-page);
kept on a coordinator's copy). `parts` split the text into plain parts and mentions
`{text: "@a1", mention: "a1"}` that join back to the text exactly. `re` and `parts` default to
null and one plain part when read.

A quote's `at` is where its text was selected, as the page that sent it opens it again: `{hash,
anchor?, message?}`, `hash` the location hash of the place (`#decision/d1`, `#decision/<fleet>/d1` on
the manager's page, `#plan`, `#agent-a2`), `anchor` the id of the element there that holds the text
(`dv-info`, `dv-body` for the evidence), `message` the id of the chat message it was selected in, as a
string. Each is a string of at most 200 characters with no control characters, the hash starting with
`#` and the message all digits; an empty or null field is left out, other keys are dropped, and any other
`at` is refused (`a quote's place is {hash, anchor?, message?}: ...`). A quote without `at` is as before.
The hub adds `page` on a coordinator's copy of the manager's message (Delivery, below).

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
text. On the manager's page (the hub's `address`) a side chat belongs to fleets: to the live
coordinator whose item its first message quotes (`quote.at`: `#decision/<fleet>/<id>`, or a chat message
from that fleet; never `#agent-<x>`, a worker's row there), and to each live coordinator that first message
cites. A name is a fleet's id exactly, or an alias exactly one live fleet has; an ambiguous one names no
owner. A message
of the user's in an owned side chat (`side`, or a `re` to one of its messages) goes to the owners plus
its own mentions and the sender of its `re` (a Reply cites), and to no one else: not the host unless cited. A side chat
no fleet owns follows the rule above.

**Open.** A message is open for each recipient until that recipient sends a message with `re` =
its id.

| Command | Does | Output | Exit |
| :-- | :-- | :-- | :-- |
| `say --as WHO [--re N] [--decision D] [--mark N[,N...]] TEXT` | appends (`--mark`, TypeScript only: the answer's `mark`, [Marks on a decision](#marks-on-a-decision-typescript-only)) | the stored line; when WHO is the host, with no `--re`, while the user's messages to the host are open (not answered with `--re`, nor answers to a decision since closed), one stderr line `chat: open from the user: #93 14:42, #95 14:48( (and K earlier)) — add \`--re N\` if this answers one` (the last five); the message is sent all the same | 1 refused |
| `inbox --as WHO` | the messages open for WHO (`user` allowed) | one line each, oldest first | 1 unknown WHO |
| `log [--after N]` | every message with id > N | one line each | 0 |
| `watch --as WHO [--after N \| --resume] [--all] [--once] [--settle SECONDS] [--fleets [--batch SECONDS]]` | prints what is open for WHO with id > N (with `--all`, every open message from the user too), then each new message to WHO (or from the user) as it lands; with `--fleets` (the manager's) also what the user does on the other fleets' pages | one line each | 0 on SIGTERM or `--once`; 1 `--fleets` not as the manager; 1 stdout is /dev/null; 1 `--once` while another watch as WHO runs for DIR; 1 without `--once` when stdout is not a terminal |
| `wait DECISION...` | waits for the user's answer to one of these open decisions | the answer's line, then `-> the user answered <ref>: record it first, ...`; for an action answered `Failed: ...`, `-> the user's step <ref> failed, and it is not done: fix it and re-present it, ...`, or --withdraw "why"; never --decide` | 1 unknown decision |

A printed line: `#<id> <from>( (<name or author>)) -> <to, each with its name>( [<ref> <decision>])( [<n> mark(s) on <ref> <id>, revision <revision>])( [side chat #N])( [delivered to <fleet> #<id>, ...])( [via <fleet> #<id>])( [from <origin>])( (quoting <from>: "<quote>"))`
`: <text>( [re #N(, mark N|, marks N, M, ...)])` (the marks parts TypeScript only). Line breaks print as ` ⏎ `, a tab as a space, and other control characters
are dropped, so a message is always one line.

`watch`: a `--once` watch holds its pid in `DIR/watch-WHO.pid` while it runs (removed at exit if still
its own), writes `watch-WHO.cursor`, the id of the last message it printed, only when it exits on its own
(`--resume` starts after it; a watch stopped by a signal leaves it), and touches `watch-WHO.left` when it
ends. What a `--once` watch exited with was handed to the session it woke: that is what "read" means.
Without `--once` the watch never exits, so in a background command it would read the chat and wake no
one: it is refused unless stdout is a terminal (`chat: a watch without --once needs a terminal: in a
background command it never exits, so nothing wakes the session. Arm \`fleet chat DIR watch --as WHO
--all --resume --once\` instead.`, exit 1, after the `--fleets` check), and on a terminal, a person
reading it, it writes none of the three files. Any watch whose stdout is /dev/null (fstat(1) has the
device and inode of /dev/null: `>/dev/null 2>&1 & disown`) is refused first, after the `--fleets` check
and before it writes anything: what it prints wakes no one, yet it would move the cursor, so the user's
message would count as read (`chat: a watch whose output goes to /dev/null wakes nobody, yet it would mark
what it reads as read. Run \`fleet chat DIR watch --as WHO --all --resume --once( --fleets)\` as a
background command of the session (run_in_background: true), never with \`& disown\` or its output
redirected to /dev/null.`, exit 1). One `--once` watch per chat and role: while `watch-WHO.pid` names a
live process that is a `--once` watch as WHO for DIR, a new one is refused before it writes anything
(`chat: a watch as WHO already runs for DIR (pid P), and its lines wake the session that armed it. Leave
it running; if that session is gone, \`kill P\` and arm the watch again.`, exit 1). A process is such a
watch by its command line (`/proc/<pid>/cmdline` and `cwd` on Linux, `ps` elsewhere): an argument `chat`
(or a path ending in `chat.py`), then DIR (resolved against the process's cwd), then `watch`, and after
them `--as WHO` (any case) and `--once`. So a pid reused by another program counts as no watch. With `--all`, a message from the user is left out for each recipient that has it in
its own chat (`delivered`): a manager's watch does not print the user's message to coordinators the hub
delivered it to, and prints, with its `[delivered to ...]` mark, one that also names the manager or a
coordinator it was not delivered to. A manager's watch prints `!` lines every `FLEET_CHECK_S`: a fleet that
doesn't read its chat while the user waits more than `FLEET_UNHEARD_S`; else, a fleet whose host has
left the user's messages to it unanswered (open for the host, no message but the user's with that `re`,
not an answer to a decision since closed) for `FLEET_UNANSWERED_S`, whatever the cursor says, since a
watch that wrote the cursor may have woken no one (`! <fleet> has not answered the user for more than 10
min: #93 at 14:42 "<text, 120 chars>", .... SendMessage its session (<session>) to answer it with \`fleet
chat DIR say --as <host> --re N ...\`, and to arm its watch as a background command, \`fleet chat DIR watch
--as <host> --all --resume --once\`; \`fleet chat DIR log --after <first - 1>\` shows them.`, each message
told once as `unanswered:<fleet>:<id>`); an answer a fleet has had
that long without recording it, a running worker silent for 20 minutes. Each is told once
(`watch-manager.told`). A coordinator's watch prints its own silent workers, and each message to
one of its workers that the worker has not answered (no message of its own with that `re`) for
`FLEET_NUDGE_S`: `! worker a1 (notes-impl) has not answered #12 from user for 10 min: "<text, 120
chars>". Forward it (SendMessage a1).` (L1: workers read their inbox at checkpoints; only a message
left this long is forwarded), and each grilling answered and waiting to be recorded: `! G6 (<title>):
every question is answered and the grilling is still open. Record it now: \`fleet state <dir> decision
G6 --decide "..." --resolution "grilling finished"\`, or withdraw it with its reason.` (once per round:
the mark is its `revised`, else `opened`). Each told once (`watch-coordinator.told`).

**When a `--once` watch exits.** What was open when it started exits at once, and so do the `!` lines of
its first look (both were due before it began). A new line (a message, or a `!` line of a later look)
does not: the watch settles, so one wake carries a burst. It keeps printing what lands and exits once no
line has come for `--settle` seconds (int; else `FLEET_WATCH_SETTLE`, else 30), each new line restarting
it, and at most `FLEET_WATCH_SETTLE_MAX` (120) seconds after the first. The user's message to WHO settles
shorter: the watch exits `FLEET_WATCH_SETTLE_USER` (10, never more than the settle) seconds after the
user's last message to WHO, whatever else lands, so the user never waits long. `--settle 0` exits with the
first batch, as before the settle. The clock is the machine's monotonic one, as `--batch`'s is (`chat.Settle`,
`Settle` in `fleet/src/chat/watch.ts`, take any monotonic seconds, so a test drives them on its own time).
`wait` is unchanged: it exits the moment the answer is given. When a `--once` watch as the host exits on
its own, and the fleet has unread news, it prints one more line, the state commands' warning 9: the
news rides on a wake the chat makes and never makes one.

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

`--once` with `--fleets`: a message to the manager (and a `!` line) settles as above; the
first news of the other fleets opens a window of `--batch` seconds (120 by default, an int), and the
watch prints all that lands in it, then exits, so one wake covers a burst of the user's actions. The
window runs on the machine's monotonic clock, as `FLEET_CHECK_S` does: a pinned `FLEET_NOW` dates what
the watch measures, not its pace. `--batch 0` exits with the first batch (the traces). Whichever of the window and the settle ends first
ends the watch.

`wait`: a closed decision prints `<ref> is already <status>: <answer or resolution>` and exits
0. An answer already given (a user message tagged with the decision) that the decision has not
recorded, as [warning 4](#warnings) reads it (a reply to it records nothing), prints at once. Otherwise it waits for the next such message, and reads the ledger again at every poll: a
decision closed meanwhile (withdrawn, or decided in the session) prints as a closed one does and
exits 0 (open-21, fixed).

**Listening** (`listening(DIR)`, the page and the warnings): `on` when a `--once` watch as the host runs
for DIR (the process its pid file names, told by its command line as above; else any such process found
among the running ones, so a watch whose pid file another watch's exit removed, or one that has not
written it yet, still counts), or its `.left` is younger than 10 minutes, or the host sent a message in the last 10
minutes. `seen` is the host's cursor (0 without one). `unread` counts the user's messages after
`seen` that no one but the user has answered with `re`, that aren't tagged with a closed
decision (by id), and that some recipient has only here (not every one of them in `delivered`). `since` is the oldest one's `at`.

### Marks on a decision (TypeScript only)

The user marks words in a decision's body (its evidence frame) on the decision's page, and sends the
marks as **one** chat message to the fleet that owns the decision. v1 covers decision bodies on a
fleet's page and on the manager's page; a grilling's context gets marks later (Python's chat.py has
none: ADR 0003).

**The batch** is a user message whose `text` is the readable Markdown the page built (what its Send
preview shows) and whose `marks` is the same, structured:

```
marks: {
  decision: {id, ref?, title, revision},   revision: the decision's `revised`, else `opened`, as the page had it
  at: {hash},                              the decision's place, as a quote's `at`: `#decision/<id>` on a
                                           fleet's page, `#decision/<fleet>/<id>` on the manager's
  items: [{n, kind, quote?, comment?, replacement?}]
}
```

- `n`: a positive int, unique in the batch; the page numbers a decision's marks 1, 2, … across the
  batches it sees, so `n` names one mark of the decision among them. The manager's page and the fleet's own
  page see different batches (the manager's page does not see one sent from the fleet's page), so two
  pages may each send an `n` of the same number. At most 100 items.
- `kind`: `comment`, `delete`, `replace`, `question` or `general` (one comment on the whole decision; no
  quote). `comment` is required for `comment`, `question` and `general`, optional otherwise;
  `replacement` (the new text) is required for `replace` and refused on any other kind. Each at most
  4000 characters.
- `quote` (every kind but `general`): `{text, prefix, suffix, hint, blocks}`.
  - `text` (≤ QUOTE_MAX): the quote as read, one line per block it crosses. A table cell is
    `  <column>: <text>` under a `Row '<first cell>'` line for its row; a selected header row is one line
    `Header of table "<caption, else the heading above it>": A | B | C`; a paragraph, list item or heading
    is its own line.
  - `prefix`, `suffix`: up to 32 characters of the body's text before the quote's first block and after
    its last (≤ 64 stored).
  - `hint` (≤ 300): where it was, as words: `under “Your questions” · a paragraph`, `table “Your
    questions”, rows 1–3, columns Question→Why`, `the table's header`.
  - `blocks` (1 to 200): `{exact, prefix, suffix, cell?}`, one per block the selection crosses, each
    anchored on its own; `cell: {table, row, rowLabel, column, head?}` for a table cell (`row` 1-based
    among the body rows, `head: true` for a header cell). Strings ≤ 2000 (`exact`), 64 (`prefix`,
    `suffix`), 200 (cell fields).

A batch with any other shape is refused (`marks are {decision, at, items}: <what is wrong>`, a mark named
`mark <n>`): `at.hash` is `#decision/<id>` or `#decision/<fleet>/<id>` for `decision.id` (encoded as the page
encodes it); `decision.id` and `revision` are 1 to 200 characters, `title` a string; a quote's `prefix`, `suffix` and `hint`, a block's
`prefix`, `suffix` and cell strings default to `""`; a cell's `row` is an int ≥ 0 and `head` is kept only
when true. Other keys are dropped and a longer quote, hint, block or cell string is cut; a longer comment or
replacement is refused. A batch is a message of its own: `marks` with a `decision`, `quote` or `side` is
refused (`a batch of marks is a message of its own: no decision, quote or side chat with it`).
`fleet/src/chat/chat.ts`'s `marksOf` and `marksAlone` are the one check (the hub's 400, `append`).

**Routing** reuses `address`. On a fleet's page the batch goes to the host, as any message of the user's.
On the manager's page a batch that is in no side chat is owned as a side chat's first message is: by the
fleet its `marks.at` names (`#decision/<fleet>/<id>`, `quotedFleet`) plus the fleets it cites. So
`decision/<fleet>/<id>` goes to that fleet only, never the manager unless cited; a batch on the manager's
own decision goes to the manager. The hub's Delivery copies `marks` into the fleet's chat with its `at`
rewritten as a quote's is (`#decision/<id>`, the fleet's own page).

**Answers.** The coordinator answers marks with `say --as coordinator --re <batch> --mark N[,N...] TEXT`:
the message gains `mark: [N, ...]`. `--mark` needs `--re` to a message with `marks`, and each N must be
one of its items (`--mark needs --re to a message with marks`, `mark N is not in message #<re>`). One
answer may cover several marks (`--mark 1,3`, or `--mark` repeated). The Courier mirrors `mark` with the answer onto the manager's page.
The page shows each answer under the mark it names; an answer with no `mark` shows under the batch.

**Printed lines.** A batch prints ` [N marks on <ref> <id>, revision <revision>]` (`1 mark` for one; the
ref is the batch's, else the chat's own decision's by id, else left out) after the decision tag
(`[3 marks on D30 d30, revision 2026-10-10T09:12:00Z]`), and its Markdown one-lined as any text, so one
watch wake carries every mark. An answer ends ` [re #12, mark 2]` or ` [re #12, marks 1, 3]`.

**The page.** Selecting words in the body offers Comment, Delete, Replace and Question beside Copy,
Reply and Side chat (one bar). The frame paints each mark as a numbered `<mark>` inside the sandboxed
frame (it is told the marks by postMessage). A block is found again after a revision by its `exact` at
the place whose `prefix`/`suffix` match best, then by the same words with whitespace collapsed, scored
the same way; it is found only when that place matches at least half of its context (up to 32
characters each side) and no other place matches as well, so a phrase repeated elsewhere never takes a
lost mark's place. A mark whose blocks are all found where they were is current, one found elsewhere (or
only some blocks) is `moved`, one with none found is `outdated` and keeps its quote; a batch says so of
each outdated mark (`_(no longer found on revision <revision>)_`). Unsent marks are drafts kept per
viewer in the browser's localStorage (`fleet-marks:<fleet>:<decision id>`, `<fleet>` the fleet's ledger
identity: the hub's id for it, else its `/f/<fleet>/`, else `project:<project>`; read and written in
try/catch); Send clears them.

**The frame is untrusted.** The body is agent-written HTML, and its own scripts run in the frame beside
the marks' script and can post the same messages. So the frame only reports a selection (its blocks:
`exact`, `prefix`, `suffix`) and that a mark was tapped, and never saves, sends, discards, opens,
scrolls, answers or types anything. The page parses the document it gave the frame (its srcdoc; on the
manager's page, the body fetched from the fleet's page) with DOMParser and confirms a selection only
when each block occurs there with that exact context; the quote, its cells and where it was are read
from that parse, and a selection that does not confirm is refused ("Could not confirm this selection").
Where each mark is now is found in that same text. A tap acts only with focus in the frame and the
user's activation. Escape pressed in the frame closes the selection bar only; Cmd/Ctrl+Enter there does
nothing. On this page Cmd/Ctrl+Enter acts on what focus is in: it sends only with focus in the preview
(which takes focus when it opens), saves only in the composer, and opens the preview from the marks'
list or with nothing focused. On the manager's page the fleet's page relays each marks' message
rebuilt from its own fields, nothing else of it. Every frame-supplied string (a quote's words, a hint,
a table's name, a column, a row's label) is one line in the batch: whitespace runs one space, control,
format and bidi characters dropped, capped, and Markdown-escaped where the text interpolates it. Sent marks are read back from the chat: the page's batches for the decision, and the answers
(`re` the batch, `mark` naming n). Answered marks show dimmed (keep) or folded into a History (clear),
a per-viewer choice.

## fleets.py and the registry

`REGISTRY/<fleet>.json`, one per fleet being served:
`{id, role (coordinator|manager), dir, url, pid, session, session_id, since, aliases?}`, written atomically (a `.tmp`
then a rename). `session` is the session's title; `session_id` its Claude Code session id, which survives
`claude respawn` where the pid does not: `fleet serve` takes it from `$CLAUDE_CODE_SESSION_ID` (Claude Code
sets it for every command a session runs), else from DIR's scratchpad path (`…/<project>/<session>/scratchpad/<name>`),
else the fleet's last entry's; null when none says. The entry's `session_id` is the session serving DIR now: a resumed session (`claude -r`) has a new id
while DIR stays in the scratchpad of the session that made it, so its transcript (`projects/*/<session_id>.jsonl`),
when found, is the one read for the fleet's last activity and title, before the scratchpad's. `aliases` are the fleet's earlier ids: every rename
(a title, `name`, a dropped session number) keeps the old id there, and the hub answers `/f/<alias>/` with
a 301 to the fleet's address. `REGISTRY/gate/gate.json` is `{fleet, kind, what, since, until, token}`: `fleet` the holder's name (a
served fleet, or with `kind: "session"` the name a session or worker gave with `--as`), `until` when the hold
lapses, `token` the one `gate free` takes (the first 8 hex digits of the SHA-256 of `fleet\nwhat\nsince`). A
file without `kind` or `until` (written before them) is a fleet's hold that lapses only with its fleet.
Every take, release and removal of a lapsed hold runs under an exclusive `flock` of `REGISTRY/gate/gate.lock`. `REGISTRY/usage/reading.json`
holds the plan usage per account, `{"accounts": {KEY: {email, seen, five_hour?, seven_day?}}}` (see usage.py). Every read of the registry (`live()`) deletes the entry of a fleet whose
pid is dead or whose record is malformed; a dead one's entry is kept as `REGISTRY/names/<fleet>.json` (one
per dir: a newer one for the same dir replaces it), so the fleet gets its name back when it is served again.
`fleet serve --stop` keeps nothing. It also renames a fleet whose session got a custom title
(`custom-title.json` beside the transcript: the entry's `session_id`'s, looked up in every project under
`$CLAUDE_CONFIG_DIR/projects/`, else, when that session has none, DIR's scratchpad's session's) to the title's slug, unless that is taken or
reserved; a missing or blank title renames nothing. In TypeScript the session's name is, first found of
(*out of the oracle, whose fixtures have none of the first, third or fourth; pinned by
fleet/test/naming.test.ts*): the name given on the fleet's page (`REGISTRY/overrides/<the first 16 hex
digits of the SHA-256 of DIR>.json`, `{dir, name}`, written by the hub's `POST /f/<fleet>/name` and removed
by an empty name or `fleet serve --stop`); the custom title; the `name` of Claude Code's live record of the
entry's pid, `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, while its `sessionId` is the entry's `session_id`
(a derived name, `nameSource: "derived"`, included); the transcript's last `{"type": "ai-title",
"aiTitle"}`. The first three but a derived name are given names and rename the fleet whenever they
change; a derived name and the AI title name only a fleet with no `session` yet, so they never undo a
`name` or an earlier title. A page name renames only the fleet: a Claude Code session's own title
cannot be changed from outside. An empty one sets `session` to null, and the next read names the fleet
after its session again (it keeps its id when nothing does). Names, on `register`: the manager is `manager`; a
coordinator is the slug of its session title when that is free; else the name of its prior entry: its own
entry, else the kept entry of its dir, else the kept entry of its session id (a respawned session serving
another dir), each only while no live fleet holds that name, with that entry's aliases and session
(dropping a session number as before); else, for a brand-new dir, the slug of its project
(`[^A-Za-z0-9_.-]+` → `-`, trimmed, lower-cased), `-fleet` added to a reserved name, `-2`, `-3`
to a taken one. A kept entry it uses is removed. `user`, `coordinator` and `manager` are reserved.

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
| `waiting` | what waits on the user, from every live fleet's ledger, the manager's included: per open decision that asks the user and is not held, `<fleet> <ref> [<kind>(, blocks work)] <title>  since <revised or opened, YYYY-MM-DD HH:MM>`, then `  ANSWERED at HH:MM (#N): <first line>; not recorded yet` when the user's answer waits unrecorded (warning 4's rule: a reply in the chat does not record an answer; only the decision command does); `nothing waits on the user`, or `no fleet is being served on this machine` | 0 |
| `list` | per live fleet, one block, blocks a blank line apart: `<id>  (<role>, <status>)`, then `  session  <session or (not named yet)>(, last active YYYY-MM-DD HH:MM)` (when the entry's `session_id`'s transcript, else DIR's scratchpad's session's, was last written), `  page     <url>`, `  ledger   <dir>`, `  now      <now>` (when set) and `  chat     not read now(; N message(s) from the user wait since #S)` (when not read); then, after a blank line and each only when it has rows: `  agents   <n> running, <n> blocked, <n> queued` (the non-zero ones) with a row per queued, running or blocked agent `    <id>  <status>  <model or ->  <label>  lanes: <first lane>( +N)  SILENT since HH:MM`, the label its `name`, or its `task` when the name is its id, one line, cut at 48 characters with `…`, and its lanes each comma-separated glob once; `  links    <n>` with `    <ref>  <kind>  <url>  <title>` per link; `  waiting  <n>` with `    <ref>  <id>  <kind>  for the user|for the manager  <title>(  blocks work)(  ANSWERED at HH:MM, not recorded)(  held by the fleet: <reason>)` per open decision; `  tokens   workers <n>; <role> <n> written, <n> read` (three figures and k, M or B, rounded half up) when the session's transcript is found. Columns are padded to the widest cell, counted in code points; trailing spaces are cut. Or `no fleet is being served on this machine` | 0 |
| `show FLEET` | now (with when it was said), chat, live workers with their last report (and `silent since HH:MM: check it before saying it runs` under a silent one), every lane of the queued, running and blocked workers, sorted, as `    lane <glob>  <agent ids>`, open decisions (and `held by the fleet since HH:MM: <reason>`, and an answer not recorded), open roadblocks, the last 8 events | 1 unknown fleet |
| `manager` | `manager  session …  <url>  <dir>` and where `standing.md` is | 1 when none |
| `decision FLEET ID` | the decision in full; the page as `<url>#decision/<id>` | 1 unknown fleet or decision |
| `gate` | `free` or `held by <holder>[ (no fleet)] since <stamp>[, until <stamp>]: <what>` (a hold lapses at its `until`, and a fleet's when the fleet is no longer served; a lapsed hold is removed) | 0 |
| `gate take FLEET\|--as NAME WHAT [--for MINUTES] [--wait SECONDS]` | `<holder> holds the gate: <what>`, then a line with the token and the `until`, naming the `gate free <token>` that frees it; `--for` (default 60) sets when the hold lapses, `--wait` retries each second until the slot is free | 1 held (by anyone, the same fleet included; the refusal names the holder, its label, since and until), FLEET not served, or a bad argument |
| `gate free TOKEN` | `free`; the holder's name in place of the token frees it too, as before tokens | 1 held by another |
| `name DIR SESSION` | `this fleet is <id>, the session <session>: use that one name everywhere`; renames the entry | 1 not served, reserved, or taken |
| `procs` | background processes each fleet's session started (by `/proc`, real time) | 0 |
| `approval add --all\|--fleets A,B --rule R --ref FLEET/DECISION[:Q<n>] [--by WHO]` | one standing approval in every served fleet's ledger (`--all`, in `live()` order) or in those `--fleets` names (ids or aliases, comma-separated, in that order): the ref is checked once as `approval add` checks it (refused as there, `fleets: <why>`, before any fleet is written), then per fleet one line: `<fleet>: skipped, K2 already comes from manager/G5:Q1 (<status>)` when an approval of its ledger, active or revoked, has the same `ref` and `question` (in the source fleet's own ledger, its decision's id as `ref` counts too); else `<fleet>: added K<n>`, n one more than its highest K, by running `state DIR approval add K<n> --rule R --by WHO --ref REF -q` (its page rendered); `<fleet>: refused, <state's reason>` when that refuses, except that a refusal after which its ledger holds an approval from that ref (another `add` ran at the same time) reads `<fleet>: skipped, ...` as above and fails nothing. `--by` defaults to the answer's author, else `user` | 1 the usage, neither `--all` nor `--fleets`, a blank rule, a ref with no fleet, a ref refused, a fleet not served (before any write), or any fleet refused (after the others) |
| `approval revoke --ref FLEET/DECISION[:Q<n>] --reason R [--fleets A,B]` | per fleet the registry knows, served or stopped (`Registry.known`: the live entries, then the kept entries of fleets no longer served, by id; a `serve --stop` forgets one), whose DIR is there (or those named, by id or alias among them), each active approval from that ref (as given, or as `<fleet>/<number>` when the registry knows the fleet and it has the decision) revoked by `state DIR approval revoke K --reason R -q`: `<fleet>: revoked K3`, `<fleet>: none active from manager/G5:Q1`, or `<fleet>: not reached, no ledger at <path>` / `<fleet>: not reached, <state's reason>`; any not reached adds `fleets: not reached: <fleet>, ...; the approval is still active there` on stderr | 1 the usage, no `--reason`, a ref with no fleet, a name the registry does not know, any fleet not reached |
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
  whose record names a public port and a started dev server (a pid recorded), the hub also serves that
  port over TLS, in the same two places (127.0.0.1 and the Tailscale IPv4, never 0.0.0.0), and passes
  every path there to that dev server at its root. It looks every second and at start, so a restarted hub
  listens again from the records alone, and it lets a port go when the preview stops. A port it cannot
  take (held by another process, or no certificate) is logged and reported, never fatal:
  `REGISTRY/hub/previews.json` holds `{pid, ports[] {port, fleet, worker, loopback, tailnet, url, error}}`
  while it runs (`url` the `https://<MagicDNS name>:<port>/` it serves, null while it serves none), read
  by `fleet preview status` and the page. A port named by two records goes to the first; the hub's own
  port is never one. No `tailscale serve` entry per preview.
  - **The certificate** is this machine's from Tailscale, the one `tailscale serve` uses: `tailscale cert
    --cert-file - --key-file - --min-validity 336h <MagicDNS name>` through the hub's `tailscale` binary
    (`$TAILSCALE`), read on stdout, split into the chain and the key, and held in memory: never written to
    disk, never logged. The hub asks at start, then looks every minute: it asks again when the
    certificate is within 14 days of its end (its `notAfter`) or the MagicDNS name has changed, once a
    minute while it holds none, hourly while a renewal fails and the one held is still valid. A renewed
    certificate replaces each port's listeners (the old ones stop accepting and finish their open
    connections, HMR sockets included); the hub's own port and the other preview ports are untouched.
  - **Fail closed**: with no certificate (Tailscale down or absent, no MagicDNS name, HTTPS certificates
    off in the tailnet, an expired one that cannot be renewed) the hub opens no public port, in plain
    http or otherwise, and records why as the port's `error` (`tailscale cert <name>: <what tailscale
    said>`); `status` and the page show `the hub cannot serve https on port N: <reason>`.
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
  [permission](#permission-grants) cannot grant; 500 store failure; `OPTIONS /chat` and a post from an
  origin the hub's config allows: [Posting from a prototype page](#posting-from-a-prototype-page)),
  `POST /chat/preview`, `GET /skills` (below), the preview (`/preview/…`, HTTP and WebSocket, and `POST
  /preview-workers`; see [The preview](#the-preview-fleet-preview)), `POST /name` (TypeScript only; under
  `POST /chat`'s write policy: 403, 415, 413): `{agent, name}` names worker `agent` (200 `{agent, name,
  name_by?}`, 400 an unknown worker or a name a mention could not tell apart, as [Names](#statepy-the-ledger-cli) words
  it), `{name}` names the fleet before every other name (200 `{id, session, path}`, the fleet's address
  after; 400 reserved or taken); an empty name gives either back to its session's; the page's state then
  carries `named: {id, session}`, the hub's alone), the files under DIR (`Cache-Control: no-store`, `decisions/*` with the
  sandbox CSP; dot files and paths out of DIR 404), and `GET /f/<fleet>/files/<path>` (TypeScript only): a file a
  `file://` link of that fleet names, read-only, at its path under the fleet's files root: DIR's parent when that
  is a session's `scratchpad` or a directory of its own under the state home (`$XDG_STATE_HOME`, else
  `~/.local/state`, not the state home itself), else DIR. Served with the sandbox CSP, `nosniff`, no-store,
  Markdown and text as `text/plain; charset=utf-8`, streamed from disk. 404 for anything else: a file no link
  names, a dot part in the path asked or in the real path a symlink leads to (relative to the root: `notes.md
  -> .env`, `repo -> .git`), `..`, a path out of the root, a symlink that leads out of it, a directory, a FIFO
  or a device (checked again when it is opened, non-blocking). 413 `text/plain` for a file over 50 MB. `/f/<fleet>` redirects (301) to `/f/<fleet>/`;
  `/f/<a>/f/<b>/…` is `/f/<b>/…`, so the manager's page, whose coordinators' links are relative,
  works under `/f/manager/`. 421 on a `Host` the hub doesn't answer to (loopback, `localhost`, the
  Tailscale IP, the MagicDNS name and short name, at its port; the https name with `--https`). On a
  root-mode preview's public port every path is that preview's (no index, no fleets), with the same 421
  rule at that port.
- **Skills** (`GET /f/<fleet>/skills`, the page lists them on a `/` at the start of a word, anywhere in
  the composer, and in an answer or a note on a decision's page; not in `a/b` or a URL): `{"skills": [{name, description, hint, source, model}], "builtins": false}`, sorted by
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
  are not offered. A message the user sends with `/<name>` at the start of a word, anywhere in it, is stored
  as typed, with no field of its own: the host (and a worker, by `brief.md`) runs that skill with the
  message's other words as its arguments (its quote as context), as if typed in its session, several
  in the order written, and answers with `--re`. Only a listed name counts; a path or URL never does. serve_dashboard.py has no such
  route; its 404 leaves the composer without a list.
- **Delivery to the coordinators** (TypeScript only: serve_dashboard.py stores the message and delivers
  nothing, so the manager forwards it as before). A message the user posts on the manager's page (not an
  answer to one of its decisions) whose recipients include live coordinators (`@<fleet>` resolves to
  `to: ["<fleet>"]` among the registry's fleets) is written, under the manager's store lock, into each
  one's own `DIR/chat.jsonl` through the chat store: `{id (its next), at, from: "user", to:
  ["coordinator"], text, re, parts (one plain part), author?, quote?, marks?, side?, via: {fleet: "manager", id:
  N}}`. The copy's quote, and a batch's `marks`, keep their place on a page that can follow it: a place on one of that fleet's own
  decisions (`at.hash` `#decision/<fleet>/<id>`, the fleet by its id or an alias) becomes `#decision/<id>`,
  its own page's address; any other place keeps the manager's address and gains `page: "/f/<manager>/"`,
  the manager's page, which the fleet's page links to. Its `re` is the coordinator's own message when N answers one mirrored from it (or a copy it has),
  else null; a side chat opened on the manager's page opens one there, a later message of it continues
  that one (a new one when the fleet has none of it); else the copy inherits its parent's side. The
  manager's message is stored with `delivered: [{fleet, id}]`, one row per copy (the link; a fleet whose
  chat cannot be written is left out of it, and the manager's watch prints the message for it as before).
  A fleet not served is no recipient: `@<gone>` stays text, the message goes to the manager (the page's To
  line says so), and the manager forwards it. *The courier*: every 300 ms the hub reads what each live
  coordinator's chat gained (from its start on a hub's first read) and mirrors each message from
  `coordinator` whose `re` is a delivered copy onto the manager's page: `{from: <fleet>, to: ["user"], re:
  N, text, parts (one plain part), quote?, mark? (the answer's, so the page shows it under its marks), side
  (N's, when it has one), via: {fleet, id}}`, at the
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

### Posting from a prototype page

TypeScript only (serve_dashboard.py and a peer hub's `/f/<fleet>@<machine>/chat` stay same-origin). A
prototype page served on another port of this machine (`https://<this machine>:7501/`, a root-mode
preview's public port) is another origin of the same site, and may post the user's message to a fleet's
chat when the hub's config lists its origin (Luiz, 2026-10-07: "as requested" by ui-coordinator and
teses-positionings).

- **The list**: `REGISTRY/hub/config.json`, `{"chat_origins": ["https://<host>:<port>", ...]}`, edited
  by hand and read at each request (no restart). An entry counts only as the exact origin a browser
  sends: `http` or `https`, the host in lower case, the port unless it is the scheme's default, no path,
  no trailing slash, no user, no `*`; any other entry is ignored, and so is a file that is not such a JSON
  object. No file, or an empty list, is the behaviour before it: every cross-origin post refused. Why a
  file in the registry and not an env var on `fleet-hub.service`: the service and its environment are built by
  the dotfiles' `modules/dev/fleet-hub.nix` (`bun src/main.ts hub --https 7443`), so a variable would need
  a dotfiles change, a rebuild and a restart per origin, where the registry already holds the hub's other
  files and the file is read live.
- **Preflight**: `OPTIONS /f/<fleet>/chat` with a listed `Origin` answers 204 with
  `Access-Control-Allow-Origin` (that origin, never `*`), `Access-Control-Allow-Credentials: true`,
  `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: content-type`,
  `Access-Control-Max-Age: 600` and `Vary: Origin`; any other origin a 403 without CORS headers. Every
  other route's `OPTIONS` is as before (405).
- **The post**: `POST /f/<fleet>/chat` with a listed `Origin` passes the same checks as the page's own
  post (the writer is the owner's tailnet login or this machine, JSON, 256 KiB), and every answer to it,
  the 4xx included, carries `Access-Control-Allow-Origin`, `-Allow-Credentials: true` and `Vary: Origin`.
  The message is the user's as if typed on the fleet's page (`author`, `@mentions`, `/skill` commands,
  `re`, `quote`, `side`), stored with `origin: "<Origin>"` and printed `[from <origin>]`. A body with a
  `decision` or `rule` (answering a decision, granting a permission) is refused 403 (`a decision is
  answered on the fleet's own page, not from another origin`): the request was for messages, and an
  answer or a grant stays on the fleet's own page. `POST /chat/preview`, `/name`, `/preview-workers` and
  a peer's fleet stay same-origin.
- **Identity**: the hub uses no cookie. The https address is `tailscale serve`, which passes the request
  to loopback with `Tailscale-User-Login` set to the browser's tailnet login, so a cross-origin fetch
  from a page on the same tailnet is identified exactly as the fleet's own page is; `credentials:
  "include"` is what the browser needs to accept the answer, not what identifies the user.
- **CSRF**: the `Origin` check is the protection. A post whose `Origin` is neither the hub's own nor
  listed is refused 403 as before, `Origin: null` included; one with no `Origin` that a browser marks
  cross-site or same-site (`Sec-Fetch-Site`) is refused too. A post with neither header (`fleet tell`,
  curl on this machine) is as before.

## Permission grants

TypeScript only: `state.py` has no `permission` kind, no trace has one, and the oracle's usage texts
stay Python's (below). Auto mode refuses a worker's tool call; the plugin's hook opens a permission for
it, the user answers on the page, and the hub, not an agent (Claude Code's classifier refuses an agent
that writes its own allow rule), adds a one-time allow rule to the session's settings. The hook
removes the rule once the call has run, or at the first tool call of the session after 30 minutes (one
constant on each side: the hook's `GRANT_TTL_S`, `permission.ts`'s option text).

- **What the hook records** (`fleet_permission_denied`, on `PermissionDenied`, which auto mode fires with
  `tool_name`, `tool_input`, `reason` and, in a subagent, `agent_id`): a Bash command an exact rule can
  hold, and an Agent spawn with any input, open a `permission`; a Bash command no exact rule can hold
  opens an `action` whose `--manual` is the command in a `nu` block; a refused call of any other tool
  opens an `action` whose `--manual` is its input as JSON, to make by hand. What a grant can clear,
  measured in auto mode on Claude Code 2.1.287 and 2.1.288 (a headless `claude -p --permission-mode auto`
  in a throwaway project, the spawn refused as `[Production Reads]`): an exact `Bash(<call>)` allow rule
  in the session root's `.claude/settings.local.json` clears a refused Bash call, live, for the session's
  subagents too; an `Agent(<type>)` allow rule there does not clear a refused spawn (auto mode drops
  `Agent` allow rules, as its docs say), and a `PreToolUse` hook's `allow` does, on the main thread as
  for subagents. So a Bash grant is an allow rule and an Agent grant is a hook's allow (below). No rule
  can name one spawn: `Agent(<type>)` matches every spawn of that type.

- **An exact rule**: `Bash(<call>)`, for a call that holds none of newline (`\n`, `\r`), `*` (a rule
  reads it as a wildcard) and `\` (Claude Code's rule parser reads an escape, so the rule would not match
  the call). This one set is `whyNoRule` in `src/ledger/permission.ts` and `RULE_UNSAFE_CHARS` in the hook; the CLI
  refuses a permission for any other call, the hook opens an action with `--manual` for it, and the hub
  grants none. For an Agent spawn the call is its `tool_input` as compact JSON with sorted keys
  (`json.dumps(..., sort_keys=True, ensure_ascii=False, separators=(",", ":"))`, the hook's `_agent_call`),
  and the rule `Agent(<call>)`, which only the plugin's hook matches; the CLI and the hub refuse an Agent
  call that is no JSON object.
- **Opening** (`fleet state DIR decision ID --kind permission --tool Bash|Agent --call CALL --cause CAUSE
  --root ROOT [--agent-id AID] [--agent WORKER] [--blocking]`; the hook also passes `--title`, `--question`
  and `--why`, which are ignored): the row gets `refusal: {tool, call, rule, cause, root, agent_id}` with
  `rule` = `TOOL(CALL)` and `agent_id` null without `--agent-id`, and the two options the CLI sets:
  `allow-once: Allow this call once | the worker runs exactly the call shown above, once, and nothing like
  it after: the one-time grant goes once it is used, or after 30 minutes` (for Agent: `starts exactly the
  agent shown above, once`) and
  `deny: Deny | the worker stays stopped; your note goes to it`; the rule and the file it goes into show
  with the call on the page. The CLI writes the title, question and why from the call
  (`src/ledger/permission-words.ts`), as it writes the options:
  - **who**: the worker's `name` (never the harness's agent id): the `--agent` row, else the agents row whose
    `task_id` is AID, else the worker whose workspace the call changes into (a `workspaces[]` row by `path`,
    or `<dirname(ROOT)>/<basename(ROOT)>-<worker id>`, as the fleet names them); else `a worker` for a
    subagent, `the coordinator` (`the manager` for a manager's ledger) for the main thread.
  - **simple or compound**: the words never understate the call. A **simple** call is one command, after at
    most one `cd <path> &&` or `cd <path>;`, with no other `;`, `&&`, `||`, `|`, `&` or newline, no `$( )`
    or backtick (quoted or not), no redirection to or from a file (`2>&1`, which copies a stream and names
    none, is kept), no `sudo`, `doas`, `eval` or `xargs`, no inline code (`sh -c`, `bash -lc`, `python -c`,
    `node -e`, `perl -e`, …), no heredoc, no `if`/`for`/`while`/`case`/`{ }`/`( )`, no unclosed quote, no
    hidden character (below), and no text that expands at run time: a `$` outside single quotes (`$B`,
    `"$@"`, `${X}`, `$IFS`) or an unquoted brace expansion (`{rm,-rf,/}`, `a{1..3}`) anywhere, the `cd`
    path included, or a glob (`r?`) as the program. Any other call is **compound**.
  - **what a simple call runs**: its whole command line after `timeout N`, `secretspec run --` and `uv
    run` (without flags of its own), every flag kept, on one line, cut at 100 characters with "…" (the
    title and question then end with ` (cut, see the exact call)`):
    `timeout 30 git push --force origin HEAD:main` runs `git push --force origin HEAD:main`.
  - **where a simple call runs**: its `cd` path, relative to ROOT when inside it by path components (so
    `/r/repo-evil` is not inside `/r/repo`; ROOT itself is "the repo root"), else in full, `..` resolved; a
    relative or `~`/`$` path as written. None without a `cd`, nor when the command then works elsewhere:
    a `-C`, `--cwd`, `--directory`-like flag, an absolute or `~` path, a `..`, or a `$` variable among its
    arguments.
  - **a compound call**: its count of parts (each command, the ones inside `sh -c '…'`, `eval` and `$( )`
    counted in place of their wrapper) and its risky markers, each once in the order found, at most six
    (then "and N more"): `pipe to <program>`, `redirect to <file>`, `redirect from <file>`, `heredoc`,
    `command substitution`, `background &`, `subshell`, `if`/`for`/`while`, `sh -c`, `python3 -c`, `node
    -e`, `eval`, `sudo`, `xargs`, `rm -rf`, `git push --force`, `git reset --hard`, a network or system
    program (`curl`, `ssh`, `dd`, `kubectl`, …), `hidden characters`, `expands at run time: <the word as
    written>`.
  - **the category in plain words**: the classifier's `[Category]` as what it means for the user, a clause
    that starts with "it": `[Real-World Transactions]` is "it may spend money or act outside this machine",
    `[Production Reads]` "it reads live production data", `[PII Data Handling]` "it handles personal data
    about people", and so on; one it does not know is "it falls under the “<category>” check".

  A simple call's title is `Allow <who> to run \`<what>\` in <where>?` (no ` in <where>` without one),
  its question `Let <who> run this exact call once? It runs \`<what>\` in <where>.`; a compound call's
  title `Allow <who> to run a compound command (<N> parts, <markers>)?`, its question `Let <who> run this
  exact call once? It is a compound command of <N> parts: read the exact call in full below before you
  answer.` An Agent call's title is `Allow <who> to start a <type> agent, described by the worker as
  “<description>”?` (`by the coordinator` for the main thread's; no description, no quote): the description
  is the caller's words, never the CLI's. The why is `Auto mode stopped this call: <category in plain
  words>. Only you can let it through.` Title, question and why go without the characters that hide or
  reorder text (`stripHidden`: U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C, and C0 and C1 controls
  but tab); the coordinator's watch strips them from its `!` lines too. Refused: a tool
  other than Bash and Agent, a CALL no exact rule can hold (above), a relative ROOT, `--option`,
  `--recommend` with the call's flags, a permission without `--tool --call --cause --root`, and those
  flags on any other kind. ROOT is the
  session root: a ROOT that is a worker's workspace of this fleet's work (as the hub tells it, under
  Granting) is recorded as its session's root, said on stderr (`state: --root <ws> is <name>'s
  workspace: recorded the session root <root>, where the subagent's session reads its permissions.`),
  or refused when that root cannot be told (`a permission's root is the session root (<roots, or "or">),
  where the subagent's session reads its permissions, not the worker's workspace <ws>`); any other ROOT
  is kept as given (the hub checks it again). A value that
  starts with `-` is given as `--call=VALUE`. The same command on the open row (the same refusal again)
  changes nothing; a changed refusal re-presents it, clears a hold, drops the explanation (recommend,
  reason and body: they were about another call) and writes the words again. `--decide`, `--withdraw` and
  `--hold` work as for any decision. `permission` is accepted by `--kind` but left out of its listed
  choices, and the five flags out of the usage (as argparse's `help=SUPPRESS`), so every usage text stays
  the twin's.
- **Explaining**: the hook's words say what was refused, not what it means, so the coordinator explains a
  permission in the turn it opens: `decision P<n> --call REV --why "<one or two lines>" --body FILE
  --recommend allow-once|deny --reason "<one line>" [--log "explained"]`, without the call's other
  flags. No one sets a permission's title or question: `--title` or `--question` on one is refused (`a
  permission's title and question are written from its call, so they never say less than it does: …`),
  while the hook's own `--title` and `--question` are ignored. REV is the call's revision, the first 12 hex digits of the SHA-256 of its rule
  (`permission.ts` `callRev`), which every explain hint below prints: on a recorded permission, `--call`
  without `--tool`, `--cause` and `--root` names that revision and never replaces the call. `--why`,
  `--recommend`, `--reason`, `--body` or `--no-body` on a permission without `--call` is refused (`an
  explanation of a permission names the call it explains, as --call <rev>: P<n>'s call is now: <call>
  (revision <rev>). Read it, then explain this call`), and with another revision too (`--call <given> is
  not the call this permission asks about any more: …`): an explanation written for a call the hook has
  since replaced never lands on the new one. The
  body says what the call does, why the worker needs it, its cost and risk (money, time, data, outside
  systems) and what a denial means. A permission is **explained** once it has a recommendation (`health.ts`
  `explained`, the page's `Core.explained`). The first explanation needs `--why`, the body and
  `--reason`; `--recommend` is `allow-once` or `deny`. The coordinator's words are checked as a decision's
  are (the why limit, the readability warnings); the hook's are not. Opening one prints `Then
  explain it, this turn: <the command>`; every state command warns `state: P<n> (<title>) is a call auto
  mode refused, and the user cannot judge it yet. Its call is <the call, a hidden character written as
  \u{…}> (revision <rev>): explain it now, ...` while one is open, unexplained and
  unanswered; the coordinator's watch says it once per revision (`! P<n> (<title>): auto mode refused a
  worker's call, and the page waits for your explanation. Explain it now: ...`), which wakes it within
  `FLEET_CHECK_S` of the hook opening it.
- **Answering**: the page shows, while the permission is open and unexplained, "Waiting for the
  coordinator to explain this request" under the ask; the explanation replaces it (the why, the body,
  the recommendation and its reason, as on a decision). The form shows "Auto mode stopped it because" and
  the category in plain words followed by the classifier's own, the rule (for Agent, that the plugin's
  PreToolUse hook lets it through) and the file it goes into; then, unfolded and directly above the
  options, "The exact call you allow" ("The exact agent you allow"): the call as an `sh` block (an Agent
  call as its input, indented JSON), monospace and wrapped; then the two options and a note; the answer
  is `allow-once: Allow this call once` or `deny: Deny`, the note on the next line, and the POST body
  carries `rule`, the rule the page showed. The answer can be given before the explanation.
- **Granting** (`src/hub/grants.ts`, before `POST /chat` stores an answer that starts with
  `allow-once` to a permission): the row must be open, its `refusal` a Bash call an exact rule can hold
  whose `rule` is `Bash(<call>)`, or an Agent call that is a JSON object whose `rule` is `Agent(<call>)`, the POST's `rule` that same rule (absent or different refuses: a row
  revised since the page rendered it needs a fresh look), and its `root` absolute, a directory, and a
  session root of this fleet (the ledger is writable by agents, the hub is not): the `project` or `cwd` of
  a heartbeat in `DIR/heartbeats/`, or else the working directory, read by the hub from the OS (`procs.ts`
  `cwdOf`), of the live process the registry's entry for DIR names as its `pid` (`fleet serve DIR
  [--pid PID]`: the session that served it). The second covers a session that writes no heartbeats (one
  whose fleet DIR is not in its scratchpad and that has no `FLEET_DIR`, or one started before the hook
  wrote them). A worker's workspace is no session root, under the fleet or beside the repo: the hook
  records `$CLAUDE_PROJECT_DIR` as `--root`, the session's root, for a subagent's refused call too (only
  the session root's settings apply, to its background subagents as well, so a rule written in the
  workspace would never apply). A row recorded by hand, or by a session older than the hook, can still
  name one: a root that is no session root but **a workspace of this fleet's work** (a `workspaces[]`
  row of the ledger by `path`, not pruned; else a jj workspace of the same repo as a session root,
  `jj workspace list` run in the session root with `--ignore-working-copy`) is granted at the session
  root whose repo holds it (the ledger row's `repo`, else jj's), or at the fleet's one session root when
  the ledger lists it and no repo matches. The session roots are each heartbeat's `project` (its `cwd`
  when it names none) and the registered session's working directory. The grant line then carries
  `workspace` (the root the row named) and the 201 answer a `grant` note: `This permission names
  <name>'s workspace <ws>; the hub granted it at the session root <root>, where <agent or "the
  worker">'s session reads its permissions.` This moves a grant only to a root the check above already
  trusts, so a forged `workspaces[]` row widens nothing. Several session roots none of which holds the
  workspace alone refuse: `This permission names <name>'s workspace <ws>, and none of this fleet's
  session roots (<roots>) is the one its session reads its permissions from, so it can't be granted
  here; ask the coordinator to record it again with --root set to that session's root.` (or, with no
  session root, `... and no session of this fleet is known to grant it at ...`). Anything else refuses in
  plain words, then what was checked: `This permission's folder <root> isn't part of this fleet's work,
  so it can't be granted here; ask the coordinator to record it again from its session. (Checked: it is
  no session root of this fleet (no heartbeat names it, and the fleet's registered session <pid> runs
  in <cwd> | and no live session is registered for this fleet), no workspace in the ledger, and no jj
  workspace of <roots>.)`; a root that is no directory, `This permission's folder <root> doesn't exist,
  so it can't be granted; ...`. A row whose `agent_id` is null adds to the `grant` note that only the
  session's main thread running the call uses the grant up, and a subagent's run leaves the rule until it
  expires, 30 minutes after the grant (the hook matches the grant's `agent_id`). Under the settings lock (below), `<root>/.claude/settings.local.json` (absent reads as
  `{}`; one that does not parse refuses) gets the rule added to `permissions.allow`, every other key and entry kept, written
  through a temp file in its folder and a rename, two-space JSON with a final newline. A missing
  `.claude` is made, and the grant says `reload: restart` (Claude Code watches only a settings folder
  that existed when the session started), else `live`. An Agent grant goes the same way into
  `<root>/.claude/tstack-grants.json` instead, same shape (`permissions.allow`), and is always `live`:
  Claude Code never reads that file, the hook reads it at each spawn. Then one line is appended to `DIR/grants.jsonl`:
  `{"op":"grant",decision,ref,rule,agent_id,file,at,by,reload[,workspace]}`, `agent_id` the row's `refusal.agent_id`
  (null: the session's main thread), `by` being `tailnet:<login>` for a
  tailnet peer that is not this machine (`tailscale whois`), else `local` (loopback, whatever header it
  carries, or this machine's own tailnet address); then the answer is stored. A rule already in `permissions.allow` is
  someone's own: the hub writes nothing and appends no grant line, so the hook never removes it, and the
  answer is stored as usual. A failed check answers
  409 with the reason and stores nothing. A `deny` is stored as any answer.
- **Letting a spawn through** (the plugin's hook, `fleet_agent_grant`, PreToolUse with matcher `Agent`):
  a spawn whose `Agent(<call>)` is in `permissions.allow` of `<$CLAUDE_PROJECT_DIR, else the input's
  cwd>/.claude/tstack-grants.json` gets `permissionDecision: allow`; anything else, an absent or broken
  file included, gets no output. It needs no fleet DIR, and it allows that input for any caller, as a
  settings rule does; the sweep below ends the grant.
- **Removal** (the plugin's hook, PostToolUse and PostToolUseFailure): a grant is `used` when the call
  that just ran is its rule's call (for Agent, the spawn's input as the rule names it) and the hook's `agent_id` (absent on the main thread) is the grant's;
  it is `expired` 30 minutes after its `at`. The hook takes the rule out under the settings lock, then
  appends a `remove` line, `{"op":"remove",decision,rule,file,at,why}` (`why`: `used` or `expired`), which
  ends the grant with the same `decision` and `rule`. The hook rewrites only an absolute
  `<root>/.claude/settings.local.json` or `<root>/.claude/tstack-grants.json`. Two hooks sweeping at once are kept apart by a
  `flock` on `grants.jsonl`, so a grant is closed once.
- **The settings lock**: hub and hook both make the directory `<dir of the file>/.settings.local.json.lock`
  (an atomic `mkdir`, which Bun and Python both have; Bun has no `flock`) around the read-modify-write of
  the settings file, retry for up to 2 s, and take over a lock older than 10 s (a crashed holder's). A
  lock still held after 2 s refuses the grant (409) or leaves the removal for the next tool call.
- **Lines**: every `grants.jsonl` line is compact JSON, one object, on both sides.
- **What it defends**: an allow rule that lets through only the call the user saw, for its caller, once.
  The Agent grants file sits in `.claude`, a protected path whose writes by an agent auto mode routes to
  the classifier, as it does a write of `settings.local.json`; an agent told to write its own grant
  there was refused as `[Self-Modification]` (measured once, Claude Code 2.1.288). With that file in
  place, the real hook let the refused spawn through on its retry.
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

- **The Stop guard** (`fleet_listen_guard`, Stop). The session hosts `$FLEET_DIR`, else only those of
  its scratchpad's folders that the hub's registry (`$FLEET_HOME`, else `fleet-board` under
  `$XDG_STATE_HOME`) has an entry for with this session's `session_id`: a ledger copied into the
  scratchpad to read is not a fleet it hosts. When a fleet the session hosts is running or blocked
  (not paused, not done) and no chat watch as its role is alive, the hook returns
  `{"decision": "block", "reason": ...}`, so the turn goes on with: `Your chat watch isn't running, so
  the user's messages and answers go unheard. Arm it as a background command (`run_in_background:
  true`, `timeout: 3300000`): `<plugin>/fleet/bin/fleet chat DIR watch --as ROLE --all --resume --once`.`
  The manager's adds when `--fleets` goes on. A watch is alive when `DIR/watch-ROLE.pid` holds a live pid
  whose command line (`/proc/PID/cmdline`, `ps -p` on the Mac) is `... chat DIR watch --as ROLE ... --once`, DIR
  resolved against the process's cwd; failing that, any process with that command line (a watch armed
  this instant, before Bun wrote its pid file). A watch without `--once` is not armed: it never exits, so
  it never wakes the session. Never twice in a row: not on a stop that already follows
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
  - an answer to a decision still open that it has not recorded (given after it was opened or revised,
    not held after it, and on a grilling not followed by a question answered or dropped), read or not;
    a reply in the chat does not record an answer; only the decision command does: `Fleet: #82 from
    the user answers A7 (<title>), not recorded for 12 min: "<text>". Record it now (`<fleet> state DIR decision A7 --decide "..." --resolution "answered on the page (#82)"`),
    then answer #82 with --re.`
  - an answer to a grilling that is then answered and waiting to be recorded, even when the fleet
    replied to it (a reply to an answer to a decision keeps it pending; a reply to any other message
    drops it): `Fleet: G6 (<title>): every question is answered and the grilling is still open, not
    recorded for 4 min. Record it now (\`<fleet> state DIR decision G6 --decide "..." --resolution
    "grilling finished"\`).`
  Each message is told once. No process, no ledger read until something is due. Measured on a chat of
  2,000 lines: 0.96 ms median in process for a first look with an item due, 0.20 ms for the usual look
  from a kept offset.

A handler of SessionStart and Stop tells the host of the machine's news ([The news](#the-news-fleet-news)):

- **News** (`fleet_news`, SessionStart and Stop). For each fleet the session hosts (the Stop guard's
  membership; a worker is out), when `REGISTRY/news/news.jsonl` holds items the fleet has not read, one
  line of context, never a block: `Fleet news: N unread for <fleet>, never a wake. Read them when
  convenient: \`<plugin>/fleet/bin/fleet news read --as <fleet>\`.` A SessionStart says it whenever any is
  unread; a Stop once per new item (the session's `fleet-news` state keeps the last item told per fleet).
  No process: it reads the registry's entries, the log and the cursor itself.

A third Stop handler of the same dispatcher holds the host to "Said once, on the page" (coordinator
SKILL.md, Respond; manager SKILL.md, Said once):

- **Said once** (`fleet_said_once`, Stop). When the session hosts a fleet (the same membership and worker
  exclusion as above) and the current turn (the transcript from its last user entry carrying text, read
  from the end: 256 KiB, doubled up to 8 MiB, else the turn is let stop) ran a Bash `fleet chat DIR say`
  whose result shows the message written (`#N ... -> ...`, not an error), and the turn's final text
  (`last_assistant_message`, else the turn's last assistant text block) is over 2 non-empty lines or 200
  characters, the hook returns `{"decision": "block", "reason": "You answered on the page (#N). Said
  once: end this turn with one line naming where, e.g. 'Answered #N on the page.' Do not repeat the
  answer here."}`. Once per turn: never on a stop that follows a stop hook's block (`stop_hook_active`),
  nor twice for one prompt (the session's `said-once` state keeps the turn's key, the prompt's uuid).
  Anything it cannot read lets the turn stop.

## The news (`fleet news`)

What a session tells the fleets and that needs nobody to act now (a release note, an FYI, a rule) is news,
not a message: a message to a session wakes it, and a wake re-reads the session's whole context. News
never wakes anyone. `news.py` is the oracle; `fleet news` the CLI.

The store is `REGISTRY/news/news.jsonl`, append-only, one item per line, appended under an exclusive
`flock` of the file: `{id, at, from, to[], kind, keep, text}`, `id` numbered from 1, `to` `["all"]` or fleet
names, `kind` `release`, `fyi` (the default) or `rule`, `keep` true when the reader saves it (a durable
rule) and false for "do not save". A line that does not parse, or lacks `id` (an int, not a bool), `from`,
`to` (a list) or `text`, is skipped; a torn last line is left alone and the next append starts a new line.
Each reader has a cursor, `REGISTRY/news/read/<fleet>`, the last id it read.

| Command | Does | Output | Exit |
| :-- | :-- | :-- | :-- |
| `post --from NAME [--to all\|FLEET[,FLEET...]] [--kind release\|fyi\|rule] [--keep] TEXT` | appends an item, text trimmed; `--to` names deduplicated in order | its line | 1 refused: a name not `[A-Za-z0-9_.-]+`, `all` among names, empty text, text over 1000 characters |
| `read --as FLEET` | prints what FLEET has not read: items after its cursor, to `all` or to it, not from it; moves the cursor to the log's last id | one line each, or `no news for FLEET` | 1 a bad name |
| `list` | every item | one line each, or `no news` | 0 |

A line: `#<id> <YYYY-MM-DD HH:MM> <from> -> <to, joined by ", "> [<kind>, keep|do not save]: <text>`, one-lined
as a chat message is.

Where a fleet learns of unread news, each one line and never a wake: the state commands (warning 9),
a `--once` chat watch as the host when it exits for a real line (above), and the plugin's SessionStart and
Stop hooks (`fleet_news`, [Listening hooks](#listening-hooks)). A fleet's name for its cursor is its registry
entry's `id`, matched by its dir.

Why no relay: an item another fleet must act on goes to that fleet as one direct message, once; routing it
through the manager wakes the manager (a large context) and then the fleet, two wakes for one.

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
  is given a **public port**, on which the hub serves it over TLS at the root of an origin of its own,
  `https://<MagicDNS name>:<port>/`, with this machine's Tailscale certificate (see [the
  hub](#the-hub-fleet-hub)); the certificate names the MagicDNS name, so that is the one address, never
  the tailnet IP, and without Tailscale there is none. The port speaks HTTP/2 (ALPN `h2`, Node's `http2`
  secure server, `fleet/src/hub/preview-serve.ts`) and HTTP/1.1 for clients without it and for
  WebSockets: over HTTP/1.1 a browser opens 6 connections per origin, so an app that holds long polls
  open (Casos keeps 17) queued every other request behind them. Any port the hub serves over TLS itself
  goes through that server, never `Bun.serve`'s `tls`, which has no HTTP/2. The port is given once per preview (the combined one, each worker's) and kept in the
  record's `ports {combined, workers {<worker>: port}}` across stops and starts, so the address stays
  good; `server.public` (and a per-worker server's) names it while that start runs in root mode. It comes
  from `FLEET_PREVIEW_PORTS` (`LO-HI`), **7500-7599** by default: beside the hub's 7420 and 7443, clear of
  the ports this machine's other servers use (Vite's 5173, 5300 and up for workers' dev servers, the
  apps' 24116-24118, 9787-9791, 8444) and below the kernel's ephemeral range (32768 and up on Linux, 49152
  on the Mac), where the dev servers' own free ports land. A port is skipped when another fleet's record
  holds it, when it is the hub's (7420, 7443, or what `hub.json` records), when `tailscale serve` exposes
  it, or when something listens on it on 127.0.0.1 or the tailnet IP now; a range with none left is
  refused. `start` and `status` print `public: https://<MagicDNS name>:<port>/` (without Tailscale,
  `public: port N, no https address: …`) and what the hub says of the port (`the hub serves it over
  https (on loopback and the tailnet)`, `the hub cannot serve https on port N: …`, `no hub runs`);
  `start` waits up to 3 s for a running hub to take the port. The page there is a secure context
  (`navigator.clipboard` works), and Vite's HMR client opens its socket as `wss` from the page's scheme.
  The `/f/<fleet>/preview/` path still leads to the same server, with the prefix stripped.
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
  is locked only by `fleet state` and the hub's rename. Each change is made under an exclusive `flock` on `DIR/preview.lock` and
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
  (no `tailscale serve` entry per preview and no change to the app), in https with the hub holding the
  machine's certificate.
- **The page** (the view's `preview`, only when `DIR/preview.json` exists, so no trace changes): `{url
  ("preview/", or null with only per-worker ones), address, running, up, port, log, updater, every,
  workers[] {id, name, status, included, commit, change}, conflicts[], error, updated, per_worker[]
  {worker, url, address, running, up, port, log, public, public_url, public_error}, public, public_url,
  public_error}`, `public` the root-mode public port or null, `public_url` the `https://<MagicDNS
  name>:<public>/` the running hub serves it at (null while it serves none) and `public_error` the
  running hub's word on it. The Fleet view's Preview block links a root-mode preview (and each per-worker
  one) at `public_url` (an `https:` address only) and shows `The hub cannot serve https on port N:
  <public_error>`. It also shows the link, a box
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
  with no workspace (isolated only), and the model and effort to spawn it on (`model: "opus", effort:
  "high"`; the model alone for a row with no effort) with the `--task-id` to record after. A worker
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
  reach the user`, skill none, no lane, model fable (or the row's, or `--model`) at the role table's
  effort for it (high, on fable and on opus), passed as `--effort` on every run, status **queued**. New:
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
  ledger, the brief and the chat are, the line that records an answer, its model and effort), and on stderr how to
  spawn it (`subagent_type "tstack:advisor"`, `model`, `effort`, in the background) and how to restart it on Opus.
  With `--task-id`: `advisor recorded on <model> at <effort> effort as <ID>`, and on stderr the line for "This fleet" in
  `brief.md` that tells workers to `SendMessage <ID>` before asking the user.
- **Fable unavailable.** Claude Code has no fallback for a subagent's model on limits, credits or
  access (`--fallback-model` covers the main loop's overload only). The Agent call's `model` overrides
  the agent's frontmatter, so the coordinator reads the failed spawn (an error naming the model, a
  usage or credit limit, no access), runs `fleet advisor DIR --model opus --log "Fable unavailable:
  <the error>"`, spawns again with `model: "opus"`, and says so in its next message.
- **Each answer is recorded on the chat**, not the ledger: `fleet chat DIR say --as advisor "<asker>
  asked: <question> | <verdict> | <reason> | <confidence>"`. The page shows both; the chat is the store
  a participant other than the coordinator may append to (under its lock, while `state.json` is the
  coordinator's, the page's renames aside), the message reaches the user, who can overrule it with a reply, and it
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
| `fleets.py gate take/free`, `name` | `REGISTRY/gate/gate.json` (under `REGISTRY/gate/gate.lock`), `REGISTRY/<fleet>.json` |
| `serve_dashboard.py` | `DIR/server.json`, `DIR/server.log`, `REGISTRY/<fleet>.json` |
| `fleet serve` | `REGISTRY/<fleet>.json` (removed with `--stop`) |
| `fleet hub` | `REGISTRY/hub/hub.json` while it runs (it reads `REGISTRY/hub/config.json`, written by hand); `DIR/chat.jsonl` on a post, and on a post to the manager's page each addressed coordinator's `DIR/chat.jsonl`; the manager's `DIR/chat.jsonl` (the courier's mirrored answers); on an allow-once to a permission, `<root>/.claude/settings.local.json` (and its folder) and `DIR/grants.jsonl`; on a page rename, `DIR/state.json` (a worker's `name`, `name_by`, `updated`, under the ledger's lock) or `REGISTRY/overrides/<hash>.json` and `REGISTRY/<fleet>.json` |
| the plugin's hook (grant removal) | `<root>/.claude/settings.local.json`, `DIR/grants.jsonl` (`remove` lines) |
| `usage.py capture` | `REGISTRY/usage/reading.json` |
| the plugin's hook (`fleet_heartbeat`) | `DIR/heartbeats/<session>[.<agent>].json` |
| the plugin's hook (`fleet_listen_guard`, `fleet_chat_nudge`, `fleet_said_once`, `fleet_news`) | nothing in DIR; the session's `fleet-guard`, `fleet-nudge`, `said-once` and `fleet-news` state in the plugin's data folder |
| `news post`, and a `state decision --kind notice` once its ledger is written, when a manager is served | `REGISTRY/news/news.jsonl` (under its `flock`) |
| `news read` | `REGISTRY/news/read/<fleet>` when the cursor moves |
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

- `cli`: `state`, `chat`, `fleets` or `news`; `argv` after the program; `clock` (optional) sets the
  virtual clock from this step on (passed as `FLEET_NOW`; the first is `2026-01-05T09:00:00+00:00`);
  `env` overrides (null unsets); `stdin`; `timeout` (default 20 s, result `"timeout"`).
- `fixture`: `write`, `append` (content a string, or an object written as one JSON line),
  `patch` (`set` and `unset` top-level keys of a JSON file) or `delete`, at `path`.
- Tokens, in argv, env, content and paths: `$W` the work root (the cwd), `$DIR` = `$W/coordinator`,
  `$REGISTRY` (`FLEET_HOME`), `$PID` the runner's own pid (a registry entry that reads as alive).
- Environment of every step: `TZ=UTC`, `LANG=C.UTF-8`, a throwaway `HOME`, `CLAUDE_CONFIG_DIR`
  and `XDG_STATE_HOME`, `FLEET_DISCOVER=0`, `FLEET_HOME=$REGISTRY`.
- While a replay runs, the runner listens on 127.0.0.1:47843 itself (`LISTENING` in run.py), so a
  link there reads as up on any machine; a link on any other port probes the host as it is.

A result file has a header line (`{"results": NAME, "trace": 1}`), then one line per step:

```json
{"step": 9, "exit": 0, "stdout": "state.json updated (decision D1)\n", "stderr": "",
 "changed": {"$DIR/state.json": {"project": "acme-billing", "...": "..."}}, "removed": ["$DIR/decisions/d4.html"]}
```

`changed` holds every file under `$W` and `$REGISTRY` the step added or changed: `.json` parsed,
`.jsonl` as a list of parsed lines (`{"raw": …}` for one that doesn't parse, `{"torn": true}` last
when the file doesn't end in a newline), `index.html` as what the fleet wrote into it:
`{"written": "html", "document": true, "state": …}`, `document` for a whole document (a `--fragment`
is `false`) and `state` the parsed payload of its `fleet-state` script (`fleets.view()`, with paths
as tokens; `null` when it has none, `{"raw": …}` when it doesn't parse), other text as text,
binary as `{"sha256": …}`. The template around the payload is not recorded: it is fleet/page's
build, which `just test-page` checks, so a page change re-records no trace. `*.pid`, `*.tmp`, `server.log` and `__pycache__` are ignored. In every
string, the session's paths read back as `$DIR`, `$W`, `$REGISTRY`, `$USERHOME`, `$TMP`, the fleet
CLI's path (`<repo>/fleet/bin/fleet`, which both implementations print) as `$FLEET`, and the
implementation's own directory as `$SKILL` (`--subst PATH=TOKEN`); a `pid` equal to the runner's
reads `$PID`. With the clock pinned, timestamps are deterministic and are compared as they are.

```
run.py run TRACE [--impl CLI=COMMAND]... [--subst PATH=TOKEN]... [-o OUT]
run.py check TRACE [EXPECTED] [--impl ...]      exit 1 at the first divergence, printed with the steps before it
run.py diff A B                                 two result files
run.py record [TRACE...]                        TRACE's .expected.jsonl (default: every trace), from the TypeScript fleet
```

Stage 2 runs `run.py check` on each trace in `oracle/traces/` with
`--impl state="fleet state" --impl chat="fleet chat" --impl fleets="fleet fleets" --impl news="fleet news" --subst <its dir>='$SKILL'`,
or sets `FLEET_ORACLE_IMPL='{"state": "fleet state", "chat": "fleet chat", "fleets": "fleet fleets", "news": "fleet news", "subst": {"<its dir>": "$SKILL"}}'`
for `test_corpus.py` and `test_model.py`. The corpus: `ledger-lifecycle`, `decisions`, `hold`,
`plan-and-grill`, `chat`, `manager` (written by hand from the tests), `manager-news` (the manager's
`--fleets` watch and `fleets waiting`), `delivered` (what the hub delivered: the marks, the manager's
watch and news leaving it out), `emptied` (open-7), `workspaces` (`set --workspaces`, the shared
fleet's refusal of lanes that meet, the isolated fleet's warning, `show`, validation, a render),
`question-limit` (a decision's question limit and its warnings), `grill-options` (a grilling question's
`--option`, its recommendation by id, a grilling's `--body`, the reason's warnings),
`why-limit` (a why over 400 refused, over 200 warned, a worker's id or name from the ledger and the internal names warned),
`grill-revise` (an open grilling's title, why and context revised with `--log`),
`news` (`fleet news`: numbering, cursors per reader, the refusals and usage errors, and the unread line on
a state command and on a chat watch's wake),
`show-me-triggers` (the warning that a decision or grilling needs a picture), `past-decision` (a past answer
referred to with no number), `approvals` (standing approvals and their K ids, notices and their news to the manager or none, `--advised` and the
advisor warnings, `reviewed` events), `approvals-fleets` (`--ref FLEET/DECISION:Q<n>` through the registry, its refusals, `fleets
approval add --all` and `--fleets`, skipped on a second run, and `fleets approval revoke` everywhere),
`model-seed-1`, `model-seed-2` (random sequences), and the page's: `render-<name>` for each
hand-written trace, the same steps with every state command rendering, plus `render-page` (a
session's scratchpad with its transcript, links, markup and U+2028 in the text, unread chat, a
manager with a coordinator's summary, the plan's usage and the gate). The TypeScript fleet is the reference
(ADR 0003): where a behaviour changes on purpose, re-record the trace from it with `just record-traces
fleet/oracle/traces/NAME.jsonl` and review the diff. The frozen Python twin is not changed to match.

## The model-based test

`oracle/test_model.py` drives 25 random sequences of 60 steps (a fresh seed each run;
`FLEET_MODEL_SEED`, `FLEET_MODEL_SEQS`, `FLEET_MODEL_STEPS`) through state.py and chat.py, with a
model: milestones and their step order, workers (status, milestone, rounds, name, tokens, lane, model,
effort, the last two by the role table read from state.py), the
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
  open by `set --status done`, lanes that meet in an isolated fleet (a refusal in a shared one), a model
  or a (model, effort) pair outside the role table, a third choice of the day asked with no advisor's view; on a
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
9. **Fixed: the page's payload wasn't in the oracle.** `index.html` is recorded by the state its
   `fleet-state` script carries, and the `render-*` traces render at every step, so `fleets.view()`
   (spent, links up or down, the manager's coordinators and usage, the gate) is compared value for
   value (an escape such as U+2028 written raw or as `\u2028` reads the same, as it does in the
   browser's `JSON.parse`). The TypeScript
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
