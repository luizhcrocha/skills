# Recording through programs

Read this file instead of [DASHBOARD.md](DASHBOARD.md)'s "The state CLI" section when your dashboard folder holds
`cloud.json`: the team has moved to the cloud. The machine's host service then writes `state.json` and `chat.jsonl`
from the cloud, and both the plugin's hook and the old CLI itself refuse every `fleet state <dir> <verb>` but `show`,
`fleet chat <dir> say`, `fleet ws <dir> add`, `split`, `trash` and `prune --apply`, every `fleet preview <dir> <verb>` but
`status`, and `fleet render <dir>/state.json`, with "this team records through programs: fleet-run". With no `cloud.json`, this file does
not apply: record with the state CLI as [DASHBOARD.md](DASHBOARD.md) says.

When `cloud.json` names `archived`, your team's project is archived, and the team is read-only. The cloud refuses
its every write with `ProjectArchived`, the room's lines among them, and this machine's host service no longer serves
it, so `fleet-run` exits 2 with "this host does not serve the team". Its page and its ledger still read. Record
nothing more: tell the user, stop your workers, and take the team's workspaces out by hand
([What stays on the old CLI](#what-stays-on-the-old-cli)). `fleet fleets list` says the same on the team's `project` line.

## The one command

`${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet-run`, written `fleet-run` below, takes one JavaScript program on standard input
and prints its outcome as JSON. `FLEET_DIR` names the dashboard folder: the client sends the program to the fleet its
`cloud.json` names. Each intent below pushes one op onto `ops`; the program ends with
`return records.apply(ops)`. Put a turn's writes in one program: a report, its step and the event that follows are one
call, not three.

```sh
FLEET_DIR=<dir> fleet-run <<'EOF'
worker("w1", { status: "done", report: "Login form done; just test-changed: test-scripts PASS" });
step("m1", "s2", "Login form", "done", "w1");
return records.apply(ops);
EOF
```

| Exit | Status | What to do |
| :-- | :-- | :-- |
| 0 | `completed` | read `ops`: one result per op, `applied` (with the key it landed under), `duplicate`, `clash` or `refused` (with today's sentence in `issue`: fix the op and send it again) |
| 2 | `error`, `paused`, or none | the program threw or ran past 30 s (nothing it had not applied is recorded); the fleet is paused; the service refused the program: another fleet's, one over 32 KiB, or a bad `--id` (the reason is on stderr); a usage error (no `FLEET_DIR`, no `cloud.json` in it, a bad flag, an empty program); or the service answered something that is not JSON. Read stderr, fix what it names, and send again |
| 3 | `queued` | the office machine is offline: the program runs once the link returns, and your next call's outcome carries it in `earlier`. Keep working; do not send it again |
| 4 | none | the service is not running ("fleet-host is not running on this machine"): nothing was sent. Tell the user, and record nothing until it runs |
| 5 | `unknown` | sent; the outcome is unknown: the program reached the service and no answer came back. Resend with `fleet-run --id <id>`, the id it printed, and the same program on stdin: under one id a program runs at most once |
| 127 | none | the shim found no `node` on PATH: nothing was sent. The client needs Node 24 |

`FLEET_DIR=<dir> fleet-run --status` prints `{ "online", "queued", "lastSync", "mode" }`: whether the office machine's link is up, how
many programs wait in its outbox, when it last synced, and the service's mode (`mirror` or `export`). It exits 0, 4
when the service is not running, and 2 on any other failure.

Which client the shim runs: `$FLEET_RUN_CLIENT`, an absolute path to a pinned client file, when set (a relative one is
refused, exit 2: the hook runs the shim from the dashboard folder, where it would name another file); else the client
in the fleet checkout the host service runs from, `$FLEET_REPO/apps/client/fleet-run.ts`
(`~/repos/luizhcrocha/fleet-live` by default), so the client and the service are one revision. That checkout moves in one
order: land the change on the fleet's master, then restart `fleet-host`. A client newer than the running service, or
an edit made in that checkout, would talk to a service of another revision.

A `clash` means you set a field from an old read (`base`) and someone changed it since: both values are kept, and the
user settles it on a clash card. Pass a `base` only when your write must not overwrite another's change; a set with no
base overwrites, as the CLI did.

A program that applied an op also gets back `drift`: up to 8 lines on what drifted on the fleet, the things it wrote to
or new since the last result listed them, each `{ what, title, why, refs, act }`. `what` names the kind ("owner done,
step open", "worker stopped", "step idle" and the rest), `refs` the ids it joins on (milestone, step, worker, change,
roadblock), and `act` what to do about it. What waits on the owner (a card they have not answered, a reviewed change to
land, a roadblock on them) is never listed: `driftMore` counts it with the lines the cap cut ("+3 older or waiting on
the owner, see the work page"). Act on each line in your next program, with the act it names, or say on the page why it
stays.

## What a program calls

`FLEET_DIR=<dir> fleet-run --types` prints the declarations of every intent, with each one's rules in its comment.
[`prelude.d.ts`](prelude.d.ts) beside this file is the same text, generated from the fleet repo (`python3
scripts/prelude_types.py`), for when no host service runs; a test fails when it is stale, and typechecks every worked
call below against it. Read them before your first program of a session: they are the API, and this file lists none
of their fields or values. A program is JavaScript, not TypeScript: a type annotation does not parse.

A new worker's fields are `worker`'s (model and effort from MODELS.md); with no `status`, it starts `running`, as the
CLI's `agent` did. The CLI's verbs map to these:

| CLI | Program |
| :-- | :-- |
| `agent`, `step`, `milestone`, `event`, `keep`, `set` | `worker`, `step`, `milestone`, `event`, `keep`, `set` |
| `event --kind decision` (your own choice, for the record) | `event("note", …)`: the cloud refuses a program's decision event |
| `chat … say` | `say` |
| `decision` (any `--kind`, `permission` with `tool`, `call`, `then` and `root`) | `decision.open`; a call that runs a script stays `fleet state`, below |
| `decision --decide` | none: the owner's answer on the page records itself ([The owner answers on the card](PROGRAMS-CARDS.md#the-owner-answers-on-the-card)) |
| `decision` with new fields and `--log` | `decision.revise(id, fields, log)` |
| `decision --hold`, `--unhold`, `--withdraw` | `decision.hold`, `decision.unhold`, `decision.withdraw` |
| `decision --body FILE`, `--no-body` | `decision.body(id, text)`, `decision.body(id, null)` |
| `grill --ask`, `--revise`, `--drop` | `grill.open` (the first round), `grill.ask`, `grill.revise`, `grill.drop` |
| `grill --answer` | none, as `--decide`: the owner answers each question on the card's page |
| `grill --done` | `grill.close(id, what was agreed)`, once no question is open |
| `roadblock`, `roadblock --resolved` | `roadblock`, `roadblock.resolve` |

**The cloud writes a card's events.** Each applied card or roadblock op gets the event the old CLI wrote for it
(decision 101): `asked` for an open, a revise or a new round, a `note` for a hold or an unhold, `decision` as it
records the owner's answer, `resolved` for a withdraw, and `blocked` or `resolved` for a roadblock. A card's close also
resolves the roadblocks that wait on it and sets their workers running again. So a program writes no event after an
open, an answer or any of these: a second one shows twice in the card's history. `event` is for what has no card
(`integrated`, `reviewed`, a `note`). A `reviewed` event's `findings` has no `proven` beside it in a program yet, so its text ends `proven P`: the Important findings that carry a proof.

## Worked calls

Each is the body of one `FLEET_DIR=<dir> fleet-run <<'EOF' … EOF`. The test `scripts/tests/test_fleet_programs.py`
runs every `ts` block of this file, then of PROGRAMS-CARDS.md and PROGRAMS-WORK.md, in order, on one team, through the fleet's real prelude and fold.

A worker's report, its step done and the next one started:

```ts
worker("w1", { status: "done", report: "Login form done; tests green", tokens: 41200, duration_ms: 912000 });
step("m1", "s2", "Login form", "done", "w1");
step("m1", "s3", "Session store", "current", "w2", { why: "Logins must survive a Worker restart (D12)" });
return records.apply(ops);
```

A decision opened for the user, with no id: the cloud numbers the card by its kind's letter (D for a decision, A an
action, S a secret, G a grilling, P a permission), and the `applied` result's `key` is its id, `D219` say. Name that
id in the chat line that follows, in the next program. `decision.open(id, fields)` opens a card under an id of your
own, which you rarely need:

```ts
decision.open({ kind: "decision", title: "Where sessions live",
  question: "Which store keeps the login sessions?",
  options: [{ id: "kv", label: "Workers KV", consequence: "cheap; a logout takes up to 60 s to reach every edge" },
            { id: "do", label: "A Durable Object", consequence: "one writer per session; logout is immediate" }],
  recommend: "do", reason: "an immediate logout is the security requirement", blocking: true });
return records.apply(ops);
```

The user's answer, read off the card. Their pick on the page decided D219 already (`status: "decided"`, `answer`
the option's id, `answer_line` their line in the chat), so the program only reads it:

```ts
return records.read({ kind: "decision", key: "D219" });
```

A yes asked before an exact command the fleet runs (a deploy, a push that deploys), as `decision --kind permission`
did. The cloud numbers it with a P and sets its options, `allow-once` and `deny`; once the owner allows it on the
page, the office host writes the exact rule into `root`'s `.claude/settings.local.json`, and the rule goes once the
call ran, or after 30 minutes. `root` is your session's root (`$CLAUDE_PROJECT_DIR`), never a worker's workspace:

```ts
decision.open({ kind: "permission", title: "May the coordinator deploy the page Worker?",
  question: "Let the coordinator run this exact call once?", tool: "Bash",
  call: "pnpm --filter page run deploy", root: "/home/luizrocha/repos/acme",
  why: "It ships the reviewed login form to production.", blocking: true });
return records.apply(ops);
```

After the yes, run the call as a Bash call of its own, unchanged, once.

A program's shorthand opens a permission only for a call that runs no script by its path. A call that does (`bash
/abs/deploy.sh`, `source /abs/env.sh`, also past an assignment or an output redirect: `CI=1 bash /abs/x.sh`,
`> /tmp/x bash /abs/x.sh`) is bound to the sha256 of each file it runs, read on this machine, and so is a `fleet ws
<dir> trash` to its repo's `.fleet/ws-pre-remove` hook, or to the hook's absence where the repo has none (a hook
that appears after the ask grants nothing): a program's card carries none, so the fold refuses the card when it
opens. It refuses there too a call no page ask can hold (whyNoAsk, DASHBOARD.md's permission row): one that does not name what it runs (`$(…)` or backticks, `bash -x
/abs/x.sh`, a script by a relative path), a program given by its path (`/abs/deploy.sh`), a wrapper (`env`,
`timeout`, `sudo`), an assignment that changes what runs (`PATH=`, `BASH_ENV=`), inline code (`node -e`), and any
program a page ask does not know. Open a script call from the machine, before it runs: `fleet state <dir> decision
<id> --kind permission --tool Bash --call '<call>' --root <root> --title … --why … --recommend … --reason …` (the
coordinator skill's "Ask for the permission before the call") hashes the files, sends the card and prints its id (exit
3: queued, the card is not open yet). A
call that command refuses keeps the old route: a `decision` card first, then the call as a Bash call of its own, and
when auto mode refuses it, the hook opens its card with the files it runs. A card the hook opens leaves you a note
beside a later tool call with its id, for your call or a worker's: read the `decisions` row with that id, not a search of
`state.json`. When the hook knows no open card for your
refused call (a pipe, which no exact rule clears, anything above, a fleet that refused or never answered the card,
a queued card), it leaves you a note: why, and the call that gets one (`bash /abs/x.sh 2>&1` for `bash /abs/x.sh
2>&1 | tail -4`), the same call again, or the terminal. The hook runs in the background, so the note comes beside a
later tool call or with the next prompt, never with the refusal. Before you tell the user a card is there, read the
fleet's `state.json`: a card is open only when a `decisions` row of kind `permission` has your exact call as
`refusal.call` and status `open`. A session serving several moved fleets gets one note per fleet for one refusal,
and one fleet's card can be open while another's note says none is: the row is what counts.

An event, and a note kept for the next session:

```ts
event("integrated", "w1's login form is in the stack; test-changed green", { agent: "w1" });
keep("The login tests need the KV binding mocked: see test/setup.ts");
return records.apply(ops);
```

A chat line answering the user's message #41:

```ts
say("The login form is in; D219 asks where sessions live.", { re: 41, decision: "D219" });
return records.apply(ops);
```

More on [PROGRAMS-CARDS.md](PROGRAMS-CARDS.md) (grillings, actions, secrets, roadblocks, holds, a changed answer, marks, a standing approval, evidence, the owner's answer on the card) and [PROGRAMS-WORK.md](PROGRAMS-WORK.md) (the work page's answers and orders).

## A read before a write

```ts
return records.read({ decisions: "open" });
```

Then pass the row's `op` as the `base` of the write that depends on it, for example
`worker("w2", { status: "stopped" }, "<op of w2's row>")`.

A worker cannot be marked `done` while a step it owns is still `current`: the cloud refuses that op and the rest of the
program applies. For a worker the same program creates, the cloud refuses the step op that left it current instead, and
keeps the worker. In the same program, close or park the step with `step(ms, id, title,
"done"|"dropped"|"pending"|"blocked", ...)`, or hand it on with `step(ms, id, title, "current", "<other worker>")`,
before or after the worker op. `stopped` and `failed` always apply, because a stop is a fact; the step stays open, and
the result's `drift` lists it as "worker stopped" until you retake or drop it. Sending `done` again to a worker that is
already done is not refused.

## Gotchas

- **A program runs in a sandbox in the cloud, not in Bun on your machine**, so it cannot read your files (`Bun.file`,
  `fs`). Pass a file's text in through the shell, as a JSON literal ([PROGRAMS-CARDS.md](PROGRAMS-CARDS.md#evidence)).
- **An op is what an intent's call makes and pushes onto `ops`**, such as `event("note", "…")` or
  `step("m1", "s3", "Session store", "current")`. An `{ op: "event", … }` object of your own is not one:
  `records.apply` throws on it, the program exits 2, and nothing that apply carries is recorded.
- **`fleet ws` refuses a moved team.** Make a worker's workspace with `jj workspace add`, as the next section says.

## What stays on the old CLI

Reads and the commands that are not the ledger: `fleet chat <dir> watch --as coordinator --all --resume --once` (the
wake, unchanged), `fleet state <dir> show`, `fleet brief`, `fleet ws <dir> list` and a dry-run `fleet ws <dir> prune`,
`fleet preview <dir> status`, `fleet advisor`, `fleet turn`, and the gate slot, `fleet fleets gate run`.

`fleet ws <dir> add`, `split`, `trash` and `prune --apply` write the ledger's workspace rows, which a moved team's ledger does
not keep, so they are refused. So a moved team has no route yet to take out a workspace prune would keep for
THROWAWAY changes or a stack beside it (`trash NAME --card ID` is refused before it reads any card). Until it has one, ask the Manager
for a one-time permission to take it out by hand (`jj --ignore-working-copy workspace forget <name>` from the
default workspace, then the folder moved into the machine's trash), then run `fleet ws trash --adopt <entry> --repo <repo>`
so `restore` and `gc` handle it. Make a worker's workspace with jj beside the repo's default workspace,
`jj workspace add <repo>-<name> -r @- --name <name>`, and name the path in the brief. When the repo has
`.fleet/ws-pre-add`, run it first, in the default workspace, and make nothing if it fails; when it has
`.fleet/ws-add <workspace> <default workspace>`, run it after. Give both the environment `fleet ws` gives its
hooks (FLEET_EVENT, FLEET_WS_ID, FLEET_WS_NAME, FLEET_WS_PATH, FLEET_WS_PORT, empty for a workspace made by
hand, FLEET_REPO, FLEET_FLEET: fleet/SPEC.md, Lifecycle hooks). `fleet preview <dir>` records its workspace and server in the ledger too, so only
`preview status` runs on a moved team.
