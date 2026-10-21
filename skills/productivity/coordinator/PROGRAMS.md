# Recording through programs

Read this file instead of [DASHBOARD.md](DASHBOARD.md)'s "The state CLI" section when your dashboard folder holds
`cloud.json`: the team has moved to the cloud. The machine's host service then writes `state.json` and `chat.jsonl`
from the cloud, and both the plugin's hook and the old CLI itself refuse every `fleet state <dir> <verb>` but `show`,
`fleet chat <dir> say`, `fleet ws <dir> add`, `split`, `trash` and `prune --apply`, every `fleet preview <dir> <verb>` but
`status`, and `fleet render <dir>/state.json`, with "this team records through programs: fleet-run". With no `cloud.json`, this file does
not apply: record with the state CLI as [DASHBOARD.md](DASHBOARD.md) says.

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

## What a program calls

`FLEET_DIR=<dir> fleet-run --types` prints the declarations of every intent, with each one's rules in its comment.
Read them before your first program of a session: they are the API, and the calls below follow them. A program is
JavaScript, not TypeScript: a type annotation does not parse.

A new worker needs `task`, `milestone`, `model` and `effort` (MODELS.md); the fleet refuses one without them, as the
CLI did. Its `status` is optional: a new worker starts `running`, as the CLI's `agent` did. The CLI's verbs map to
these:

| CLI | Program |
| :-- | :-- |
| `agent`, `step`, `milestone`, `event`, `keep`, `set` | `worker`, `step`, `milestone`, `event`, `keep`, `set` |
| `chat … say` | `say` |
| `decision` (any `--kind`, `permission` with `tool`, `call`, `then` and `root`) | `decision.open` |
| `decision --decide` | `decision.decide` |
| `decision` with new fields and `--log` | `decision.revise(id, fields, log)` |
| `decision --hold`, `--unhold`, `--withdraw` | `decision.hold`, `decision.unhold`, `decision.withdraw` |
| `decision --body FILE`, `--no-body` | `decision.body(id, text)`, `decision.body(id, null)` |
| `grill --ask`, `--revise`, `--answer`, `--drop` | `grill.open` (the first round), `grill.ask`, `grill.revise`, `grill.answer`, `grill.drop` |
| `grill --done` | `decision.decide(id, "done", what was agreed)` |
| `roadblock`, `roadblock --resolved` | `roadblock`, `roadblock.resolve` |

**The cloud writes a card's events.** Each applied card or roadblock op gets the event the old CLI wrote for it
(decision 101): `asked` for an open, a revise or a new round, a `note` for a hold or an unhold, `decision` for a
decide, `resolved` for a withdraw, and `blocked` or `resolved` for a roadblock. A card's close also resolves the
roadblocks that wait on it and sets their workers running again. So a program writes no event after an open, a
decide or any of these: a second one shows twice in the card's history. `event` is for what has no card
(`integrated`, `reviewed`, a `note`).

## Worked calls

Each is the body of one `FLEET_DIR=<dir> fleet-run <<'EOF' … EOF`. The test `scripts/tests/test_fleet_programs.py`
runs every `ts` block of this file, in order, on one team, through the fleet's real prelude and fold.

A worker's report, its step done and the next one started:

```ts
worker("w1", { status: "done", report: "Login form done; tests green", tokens: 41200, duration_ms: 912000 });
step("m1", "s2", "Login form", "done", "w1");
step("m1", "s3", "Session store", "current", "w2");
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

A decision decided (an answer the user gave on the page or in the session):

```ts
decision.decide("D219", "do", "A Durable Object per session: logout must be immediate.");
return records.apply(ops);
```

A yes asked before an exact command the fleet runs (a deploy, a push that deploys), as `decision --kind permission`
did. The cloud numbers it with a P and sets its options, `allow-once` and `deny`; once the owner allows it on the
page, the office host writes the exact rule into `root`'s `.claude/settings.local.json`, and the rule goes once the
call ran, or after 30 minutes. `root` is your session's root (`$CLAUDE_PROJECT_DIR`), never a worker's workspace:

```ts
decision.open({ kind: "permission", title: "May the coordinator deploy the page Worker?",
  question: "Let the coordinator run this exact call once?", tool: "Bash",
  call: "bash /home/luizrocha/repos/acme/scripts/deploy.sh", root: "/home/luizrocha/repos/acme",
  why: "It ships the reviewed login form to production.", blocking: true });
return records.apply(ops);
```

After the yes, run the call as a Bash call of its own, unchanged, once.

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

## Cards after they open

The calls below go on from the ones above, on the same team.

**A grilling** takes an id of your own, and its questions with their options. Each question's `body` is the
question itself:

```ts
grill.open("g1", { title: "How users sign in", question: "Two questions settle how the login form signs users in.",
  why: "The form ships this week, and both answers change what the session store keeps.", blocking: true }, [
  { id: "q1", title: "Which ways to sign in the form offers", body: "Should the form offer passkeys, passwords, or both?",
    options: [{ id: "a", label: "Passkeys only", consequence: "no password to leak; a phone without passkeys cannot sign in" },
              { id: "b", label: "Both", consequence: "every device signs in; passwords need a reset flow" }],
    recommend: "b", reason: "Some users still have phones without passkeys." },
  { id: "q2", title: "How long a user stays signed in", body: "How long should a session last before the user signs in again?",
    options: [{ id: "a", label: "30 days", consequence: "users rarely sign in again; a lost laptop stays signed in" },
              { id: "b", label: "1 day", consequence: "a sign-in every morning" }],
    recommend: "a", reason: "The app holds no payment data." }]);
return records.apply(ops);
```

The owner's answer arrives as one chat line tagged with the card, a `Qn:` line per question answered
(`Q1: b: Both (as recommended)`). Record each with `grill.answer`, from its line. `grill.ask`, `grill.revise`,
`grill.answer` and `grill.drop` read the card, so `await` each before `records.apply(ops)`. Once every question is
answered, close the grilling with what was agreed, in the same program:

```ts
await grill.answer("g1", "q1", "b: Both");
await grill.answer("g1", "q2", "a: 30 days");
decision.decide("g1", "done", "Passkeys and passwords; a session lasts 30 days.");
return records.apply(ops);
```

A follow-up is a new round, `await grill.ask("g1", { id: "q3", of: "q1", title: "…", body: "…", options: […] }, "why it follows")`,
and a question nobody needs goes with `await grill.drop("g1", "q3", "why")`.

**An action** is a step only the owner can take: `hand` says why only they can, and `manual` is the steps they run
(DASHBOARD.md, "An action by hand", has the manual's rules). **A secret** names in `secret` the secret to set, never
its value, and says in `manual` how to set it by hand:

```ts
decision.open({ kind: "action", title: "Add the login domain",
  question: "Add login.acme.test to the login Worker?",
  hand: "The production Cloudflare account needs your security key.",
  manual: "1. Open dash.cloudflare.com, then Workers, then acme-login, then Settings.\n2. Under Domains, click Add and type `login.acme.test`.",
  agent: "w2", blocking: true });
decision.open({ kind: "secret", title: "The session store's signing key",
  question: "Set SESSION_SIGNING_KEY for the login Worker?",
  why: "The session store signs each cookie with it.", secret: "SESSION_SIGNING_KEY",
  manual: "1. In a terminal, run `cd ~/repos/acme; secretspec set SESSION_SIGNING_KEY`.\n2. Paste the key when it asks.",
  agent: "w2" });
return records.apply(ops);
```

**A roadblock that needs the owner** names the open card it waits on, so it comes after the card, in a later
program, once the card's `applied` result gave its id (`A219` here). The fleet refuses a `needs: "user"` roadblock
with no open card. The cloud marks the worker blocked, and resolves the roadblock when the card closes:

```ts
roadblock({ title: "The session store waits on its domain", detail: "w2 cannot route the store until A219 is done.",
  agent: "w2", severity: "serious", needs: "user", decision: "A219" });
return records.apply(ops);
```

**A failed action.** The owner answers `Failed: <what happened>`, and the fleet refuses `decision.decide` on it until
it changes. Fix the cause, then re-present it with new steps and a one-line log:

```ts
decision.revise("A219", { manual: "1. Open dash.cloudflare.com, then Workers, then acme-login, then Settings.\n2. Under Domains and Routes, click Add, then Custom domain, and type `login.acme.test`." },
  "the Add button moved under Domains and Routes");
return records.apply(ops);
```

When the owner answers Done, decide it. The close resolves the roadblock and sets w2 running:

```ts
decision.decide("A219", "done", "the owner did it on the page (#58)");
return records.apply(ops);
```

**Hold, unhold, withdraw.** `decision.hold` keeps a card open and takes it off the owner's list while the fleet works
on it; `decision.unhold("S219")` puts it back, and so does a revise with new words (question, options, manual):

```ts
decision.hold("S219", "w2 tries the key the Worker's binding derives first");
return records.apply(ops);
```

`decision.withdraw` closes a card nobody needs any more:

```ts
decision.withdraw("S219", "the Worker derives the key from its binding");
return records.apply(ops);
```

**Change my answer.** On a closed card the page's Change my answer sends a chat line, not an answer: it quotes the
card and starts "I want to change my answer. ". To change a closed card's answer, open a new card that asks again,
with `supersedes` naming the card it replaces; the fleet refuses a `supersedes` that names a card it does not hold.
`--types` does not declare `supersedes` on `Card` yet (a fix logged on the fleet's side), and `decision.open` passes it
through all the same:

```ts
decision.open({ kind: "decision", title: "Where sessions live, asked again", supersedes: "D219",
  question: "Which store keeps the login sessions, now that a slower logout is acceptable?",
  why: "You changed your answer in #61.",
  options: [{ id: "kv", label: "Workers KV", consequence: "cheap; a logout takes up to 60 s to reach every edge" },
            { id: "do", label: "A Durable Object", consequence: "one writer per session; logout is immediate" }],
  recommend: "kv", reason: "your #61: the cost matters more than a 60 s logout" });
return records.apply(ops);
```

Then answer #61 in the next program, naming the new card: `say("D220 asks it again, with KV recommended.", { re: 61, decision: "D220" })`.

**A marks batch.** Marks the owner put on a card's words reach you as one chat line of their own, the batch. It comes
alone, or just before the answer it rides with (the batch is #63, the answer #64). Read the batch first and handle
every mark before you record the answer: a mark can change what the answer means. A mark that asks for a change
(delete, replace, comment, a general note) is settled by revising the card (`decision.revise`, `decision.body`,
`grill.revise`), a question by an answer. Answer the batch with `say` and `re`. `say` takes no mark numbers, so one
line answers the whole batch: name each mark's number in its text.

```ts
decision.revise("D220", { why: "You changed your answer in #61. With KV, a signed-out user stays signed in for up to 60 s on other edges." },
  "the why says what a slower logout means, for mark 1 of #63");
say("Mark 1: the why now says what a 60 s logout means.", { re: 63, decision: "D220" });
return records.apply(ops);
```

## Evidence

`decision.body(id, text, { markdown: true })` attaches the evidence the card's page shows, as `--body FILE` did; an
HTML fragment needs no option. `await` it before `records.apply(ops)`. A program cannot read the file, so the shell
puts its text in as a JSON string literal ahead of the program:

```sh
{ printf 'const page = %s;\n' "$(jq -Rs . evidence.md)"; cat <<'EOF'
await decision.body("D220", page, { markdown: true });
return records.apply(ops);
EOF
} | FLEET_DIR=<dir> fleet-run
```

For a short `evidence.md`, the program it sends reads:

```ts
const page = "## Logout on each store\n\n| Store | A logout reaches every edge |\n| :-- | :-- |\n| Workers KV | within 60 s |\n| A Durable Object | at once |\n";
await decision.body("D220", page, { markdown: true });
return records.apply(ops);
```

A program takes at most 32 KiB (32,768 bytes of UTF-8), its literal included. A longer one exits 2. Up to about 64 KiB, stderr says "a program takes
at most 32768 bytes"; past that, the host cuts the request short and stderr names a parse error. The literal adds a byte for each newline, quote and backslash of the file, so
keep `evidence.md` under about 30 KiB. A body may take 2 MB (`--types`), but no program carries that much: it reads no
file, it reaches no network, and each `decision.body` replaces the card's last body, so a body does not split across
calls. Publish bigger evidence whole as a page of its own (an Artifact), and attach a body that sums it up and links
that page.

## A read before a write

```ts
return records.read({ decisions: "open" });
```

Then pass the row's `op` as the `base` of the write that depends on it, for example
`worker("w2", { status: "stopped" }, "<op of w2's row>")`.

## Gotchas

- **A program runs in a sandbox in the cloud, not in Bun on your machine**, so it cannot read your files (`Bun.file`,
  `fs`). Pass a file's text in through the shell, as a JSON literal (Evidence, above).
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
THROWAWAY changes (`trash NAME --card ID` is refused before it reads any card). Until it has one, ask the Manager
for a one-time permission to take it out by hand (`jj --ignore-working-copy workspace forget <name>` from the
default workspace, then the folder moved into the machine's trash), then run `fleet ws trash --adopt <entry> --repo <repo>`
so `restore` and `gc` handle it. Make a worker's workspace with jj beside the repo's default workspace,
`jj workspace add <repo>-<name> -r @- --name <name>`, and name the path in the brief. When the repo has
`.fleet/ws-pre-add`, run it first, in the default workspace, and make nothing if it fails; when it has
`.fleet/ws-add <workspace> <default workspace>`, run it after. Give both the environment `fleet ws` gives its
hooks (FLEET_EVENT, FLEET_WS_ID, FLEET_WS_NAME, FLEET_WS_PATH, FLEET_WS_PORT, empty for a workspace made by
hand, FLEET_REPO, FLEET_FLEET: fleet/SPEC.md, Lifecycle hooks). `fleet preview <dir>` records its workspace and server in the ledger too, so only
`preview status` runs on a moved team.
