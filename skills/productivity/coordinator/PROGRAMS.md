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
| `event --kind decision` (your own choice, for the record) | `event("note", …)`: the cloud refuses a program's decision event |
| `chat … say` | `say` |
| `decision` (any `--kind`, `permission` with `tool`, `call`, `then` and `root`) | `decision.open` |
| `decision --decide` | none: the owner's answer on the page records itself ([The owner answers on the card](#the-owner-answers-on-the-card)) |
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

A program opens a permission only for a call that runs no script by its path. A call that does (`bash
/abs/deploy.sh`, `source /abs/env.sh`, also past an assignment or an output redirect: `CI=1 bash /abs/x.sh`,
`> /tmp/x bash /abs/x.sh`) is bound to the sha256 of each file it runs, read on this machine, and so is a `fleet ws
<dir> trash` to its repo's `.fleet/ws-pre-remove` hook, or to the hook's absence where the repo has none (a hook
that appears after the ask grants nothing): a program's card carries none, so the fold refuses the card when it
opens. It refuses there too a call no page ask can hold (whyNoAsk, DASHBOARD.md's permission row): one that does not name what it runs (`$(…)` or backticks, `bash -x
/abs/x.sh`, a script by a relative path), a program given by its path (`/abs/deploy.sh`), a wrapper (`env`,
`timeout`, `sudo`), an assignment that changes what runs (`PATH=`, `BASH_ENV=`), inline code (`node -e`), and any
program a page ask does not know. Open a script call from the machine: run it as a Bash call of its own, and when
auto mode refuses it, the hook opens its card with the files it runs. When the hook knows no open card for your
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

The owner answers each question on the card's page: their write marks it `answered`, with the words after its
`Qn: `, and the card stays open. A chat line tagged with the card tells you, a `Qn:` line per question answered
(`Q1: b: Both (as recommended)`); no program records those answers. Read them off the card:

```ts
return records.read({ kind: "decision", key: "g1" });
```

Once no question is open (each answered, or dropped), close the grilling with what was agreed:
`grill.close("g1", "Passkeys and passwords; a session lasts 30 days.")`. It is decided with no answer of its own, and
the cloud refuses the close while a question is open. `grill.ask`, `grill.revise` and `grill.drop` read the card, so
`await` each before `records.apply(ops)`.

A follow-up is a new round, `await grill.ask("g1", { id: "q3", of: "q1", title: "…", body: "…", options: […] }, "why it follows")`,
and a question nobody needs goes with `await grill.drop("g1", "q3", "why")`.

**An action** is a step only the owner can take: `hand` says why only they can, and `manual` is the steps they run
(DASHBOARD.md, "An action by hand", has the manual's rules): every step is in `manual`, never deferred to the body
(Luiz #614, #804); the `fleet state` CLI refuses a manual that does, and the cloud's `decision.open` is the fleet
repo's to hold to the same rule. **A secret** names in `secret` the secret to set, never
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

**A failed action.** The owner answers `Failed: <what happened>`, which leaves the card open with their line in the
chat. Fix the cause, then re-present it with new steps and a one-line log:

```ts
decision.revise("A219", { manual: "1. Open dash.cloudflare.com, then Workers, then acme-login, then Settings.\n2. Under Domains and Routes, click Add, then Custom domain, and type `login.acme.test`." },
  "the Add button moved under Domains and Routes");
return records.apply(ops);
```

When the owner answers Done on the page, their write decides the card; no program records it. The close resolves the
roadblock and sets w2 running.

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
every mark before you act on the answer: a mark can change what the answer means. A mark that asks for a change
(delete, replace, comment, a general note) is settled by revising the card (`decision.revise`, `decision.body`,
`grill.revise`), a question by an answer. Answer the batch with `say` and `re`. `say` takes no mark numbers, so one
line answers the whole batch: name each mark's number in its text.

```ts
decision.revise("D220", { why: "You changed your answer in #61. With KV, a signed-out user stays signed in for up to 60 s on other edges." },
  "the why says what a slower logout means, for mark 1 of #63");
say("Mark 1: the why now says what a 60 s logout means.", { re: 63, decision: "D220" });
return records.apply(ops);
```

**A standing approval** is asked on a card of its own: the question names the act in plain words, and
`approval_question` and `approval_rule` go on the card when you open it (it lands as D221 here):

```ts
decision.open({ kind: "decision", title: "Deploy previews without asking",
  question: "May the fleet deploy a preview of any branch without asking each time?",
  options: [{ id: "yes", label: "Yes", consequence: "previews deploy after a green test-changed; you see each one as a notice" },
            { id: "no", label: "No", consequence: "each preview deploy waits on a permission card" }],
  approval_question: true, approval_rule: "deploy a preview of any branch after a green test-changed",
  why: "Six preview deploys this week each waited on a permission card." });
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

## The work page's answers

The work page lists every jj change not on trunk. The owner answers a row with one of four buttons, and a program
answers it with the work prelude's `accept`, `drop`, `hand` or `park`. Send this read at the start of every turn,
with `team` set to your fleet's id. It returns each answer no event names yet: this team's rows (a row given to this
team included) and the rows this team gave away, which leave its plain `work.read()`. A park whose decision has
closed comes back after its `wait` event:

```ts
const team = "skills";
const away = (await work.read({ team: null })).filter((r) =>
  r.answer?.answer === "hand" && r.answer.to !== team && r.item?.owner?.team === team);
const answered = [...(await work.read()), ...away].filter((r) => r.answer !== null);
if (answered.length === 0) return [];
const acted = new Set((await records.read({ kind: "event" })).map((e) => String(e.record.text ?? "").split(": ")[0]));
const tag = (r, act) => `work ${act} ${r.key}@${r.answer.commit} ${r.answer.at}`;
const act = (r) => (away.includes(r) ? "gave" : r.answer.answer);
const closed = async (d) => d !== undefined &&
  (await records.read({ kind: "decision", key: d })).some((c) => c.record.status !== "open");
const due = [];
for (const r of answered) {
  if (acted.has(tag(r, act(r)))) continue;
  if (acted.has(tag(r, "wait")) && !(r.answer.answer === "park" && (await closed(r.answer.decision)))) continue;
  due.push(r);
}
return due.map((r) => ({
  tag: tag(r, act(r)), wait: tag(r, "wait"), by: r.answer.by._tag, note: r.answer.note, to: r.answer.to,
  decision: r.answer.decision, repo: r.item?.repo, title: r.item?.title, workspace: r.item?.workspace,
  worker: r.item?.owner?.worker, changedSince: r.flags.changedSince }));
```

`by` is `owner` for the owner's answer and `program` for a coordinator's. The change id is the last part of the key
(`tstack/zpxtlnro`). Run every jj command for a row in the checkout of its `repo`. Start each act in the turn that
reads it; a landing then runs over several turns:

| Button | Act in `tag` | What you do |
| :-- | :-- | :-- |
| Ready to land | `accept` | Once the change's worker is done or stopped, bring the change into the stack and land it as any other change: the review its level asks, `land-check`, the gate, and the landing turn under a manager. The answer says the change should land; it records no review and approves no push. |
| Discard… | `drop` | Stop its worker if it runs. Abandon only when `jj log -r 'descendants(<change>) ~ <change>'` lists nothing, or only the empty `@` of the row's `workspace`, and no live worker (status `running`, `queued` or `blocked`, as `fleet ws` counts them) holds the change: `fleet ws <dashboard-dir> list` shows none of those statuses after `worker <worker id>` on the workspace's line, and no worker row with one of them in `records.read({ kind: "worker" })` is `worker` or has a `lane` that holds a file of `jj diff -r <change> --name-only`. Then run `jj abandon <change>`, and when `workspace` holds nothing ahead of trunk, take it out ([What stays on the old CLI](#what-stays-on-the-old-cli)). Never take out `default`. Otherwise abandon nothing, and record the `wait` tag with what holds the change. |
| Give to team… | `hand` | The change is this team's now. Add it to the plan as your own work, take it into a workspace of your own, and land or discard it as any other. |
| Give to team…, given away | `gave` | Stop the change's worker if it runs, drop the change from your plan, and put nothing more in its workspace. The receiving team works on it from a workspace of its own. |
| Wait for decision… | `park` | Record the `wait` tag, naming `decision`. The read brings the row back, tagged `park`, once that card of this team's ledger is closed. Then do what its answer says and record the `park` tag. With no `decision`, or a card this ledger does not hold, the `wait` holds until the owner's next answer on the row. |

The answer names the commit the owner saw. With `changedSince: true` the change was rewritten after the answer. When
`jj interdiff --from <commit> --to <change>` is empty (a rebase), act on the answer. Otherwise record the `wait` tag
and leave the change for the owner's next answer.

Record each act in the program that does it, as a `note` event whose text opens with the `tag` or the `wait` the read
returned, copied as it is, then a colon and a space. The event marks the answer read. An answer with no event comes
back on every read, and the step is done when the read returns `[]`. A new answer has a new time in its tag, so the
owner's accept after a park comes back even on the same commit. The event also tells the page what happened before
the page raises the row ("ready to land 24 h ago, still not on trunk"):

```ts
event("note", "work drop tstack/zpxtlnro@3209d730e5c1a8b4f6d2097c3e8a1b5d4f60c2e9 2026-10-14T11:00:00.000Z: abandoned; workspace zpxtlnro held nothing else and is out");
event("note", "work wait tstack/oqlvqlln@0123abcd4567ef890123abcd4567ef890123abcd 2026-10-14T11:00:00.000Z: rewritten since the answer, the interdiff is not empty");
event("note", "work wait tstack/wxyzklmn@3209d730e5c1a8b4f6d2097c3e8a1b5d4f60c2e9 2026-10-14T11:00:00.000Z: waits on D275");
return records.apply(ops);
```

## A read before a write

```ts
return records.read({ decisions: "open" });
```

Then pass the row's `op` as the `base` of the write that depends on it, for example
`worker("w2", { status: "stopped" }, "<op of w2's row>")`.

## The owner answers on the card

The cloud's owner-answer gate (its `OWNER_ANSWERS_FROM`) is on since 2026-10-28 20:35 UTC; this text ships with it.

- **The owner's write is the record.** The page sends the owner's answer with its form (the option they picked, an
  input's words, their note, or a grilling's picks), and the cloud records it on the card at once: `status:
  "decided"`, `answer` (the option's id, an input's or a secret's words, or `done`), and `answer_line`, the id of
  their line in the chat. A grilling's question is marked `answered`, with the words after its `Qn: `, and the card
  stays open. Read the answer off the card (`records.read({ kind: "decision", key })`, or the watch's line) and act
  on it. Only `answer_line` says the owner answered: `resolution` is a program's prose, whatever it says, and the
  cloud refuses one that reads as the page's own "answered on the page (#N)".
- **No program records an answer.** The cloud refuses `decision.decide`, `grill.answer`, and any op that sets a
  card's `status: "decided"` or its `answer`, or marks a question answered: "the owner answers on the card's page; a
  program can't record it". Two ops still close a card: a notice opened under an active approval (`under`), and
  `grill.close(id, resolution)` on a grilling with no question open. `decision.withdraw` stays. A decided card keeps
  its answer, resolution and closed time, so a program sets none of them: on a card that holds the owner's answer
  the cloud refuses with "a program cannot set the resolution of decision D219 while it holds the owner's answer
  (#41)". To change them, reopen the card (`decision.revise` with `status: "open"`) or withdraw it.
  `decision.decide` and `grill.answer` stay in the prelude until the rollout is done, and the cloud refuses both. A
  team that has not moved records with the state CLI, as before.
- **An answer typed in the chat counts for nothing**, and so does one given in the terminal. Do not record it, and
  do not act on it as the card's answer. Answer the line at once: `say("Answer on the card, please: D219.", { re: 41,
  decision: "D219" })`. The page turns the card's number into its link.
- **None of these, and an action's Failed:**, leave the card open with the owner's line in the chat. Revise the card
  from their note, or withdraw it.
- **A change the owner reads asks again.** A revise of a field the page shows (the question, options, why, recommend,
  reason, approval_rule and the rest) bumps the card's `rev`, and the page refuses an answer begun on the words
  before. On a grilling, a question re-worded is asked again, and so is a follow-up (`of`) of it.
- **A card for the Manager** (`asks: "manager"`): once the Manager answers, withdraw it with `decision.withdraw(id,
  "answered by the Manager outside the chat: <gist>")`. When the answer is the user's to give, open a new card for
  the user.
- **A standing approval comes from the card, not from you.** Two answers back one: the user's plain yes (Yes,
  Approve, OK, Sim) on a card opened with `approval_question` and `approval_rule`, picked with no note while the page
  showed the rule; or allow-kind with no note on a permission, when its rule covers every call it asked for. An
  allow-once never backs one, and neither does a yes on a card opened without `approval_question`. Then push the
  approval op under your next K, naming the card: `ops.push({ record: { kind: "approval", key: "K7" }, set: { ref:
  "D221", by: "luiz", status: "active" } })` (on a grilling, `question` names the question too). The cloud fills
  its rule (the one the owner's form showed), message (their line) and author from the card, and stamps `added`; a
  value of yours that differs is refused. One line backs one approval, and an approval that is there may only be
  revoked.
- **A fleet-wide approval does not reach a moved team**: the cloud refuses an approval whose `ref` names another
  fleet's card (`manager/G5:Q1`). Ask on this team's own page with an approval question.
- **Ask once, link the rest** works as [SKILL.md](SKILL.md) says: the user answers on the asking card, and you
  withdraw yours after they answered. An answer they give on your own card is recorded there as any other.

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
