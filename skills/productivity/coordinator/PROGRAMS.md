# Recording through programs

Read this file instead of [DASHBOARD.md](DASHBOARD.md)'s "The state CLI" section when your dashboard folder holds
`cloud.json`: the team has moved to the cloud. The machine's host service then writes `state.json` and `chat.jsonl`
from the cloud, and both the plugin's hook and the old CLI itself refuse every `fleet state <dir> <verb>` but `show`,
`fleet chat <dir> say`, `fleet ws <dir> add`, `split` and `prune --apply`, every `fleet preview <dir> <verb>` but
`status`, and `fleet render <dir>/state.json`, with "this team records through programs: fleet-run". With no `cloud.json`, this file does
not apply: record with the state CLI as [DASHBOARD.md](DASHBOARD.md) says.

## The one command

`${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet-run`, written `fleet-run` below, takes one TypeScript program on standard input
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
| 2 | `error`, `paused`, or none | the program threw or ran past 30 s (nothing it had not applied is recorded); the fleet is paused; the service refused the program (another fleet's, over its size limit (413), a bad `--id`: the sentence is on stderr); a usage error (no `FLEET_DIR`, no `cloud.json` in it, a bad flag, an empty program); or the service answered something that is not JSON. Read stderr, fix what it names, and send again |
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

`FLEET_DIR=<dir> fleet-run --types` prints these declarations; when they differ from the copy below, the printed ones hold.

```ts
type OpId = string;
type Kind = "fleet" | "milestone" | "worker" | "decision" | "event" | "roadblock" | "approval" | "link" | "kept" | "message";
/** One op a program makes; the runtime stamps its id, host, author and time. */
interface LogDraft { record: { kind: Kind; key?: string }; set?: Record<string, unknown>; add?: unknown; base?: OpId }
/** What the fleet did with one op: applied under key, a duplicate, a clash on a field, or refused with the reason. */
type OpResult =
  | { _tag: "applied"; id: OpId; kind: Kind; key: string }
  | { _tag: "duplicate"; id: OpId }
  | { _tag: "clash"; id: OpId; kind: Kind; key: string; field: string; base: OpId; current: OpId | null; kept: unknown; lost: unknown }
  | { _tag: "refused"; id: OpId; kind: Kind; key?: string; issue: string };
type Query = { kind: Kind; key?: string } | { decisions: "open" };
/** Each row's op is the base to pass when a later set must not overwrite someone else's change. */
type View = { kind: Kind; key: string; op?: OpId; record: Record<string, unknown> }[];
declare const records: { apply(ops: LogDraft[]): OpResult[]; read(q: Query): View };
/** The ops the intents below pushed, in order: end a program with `return records.apply(ops)`. */
declare const ops: LogDraft[];
/** Make or change worker id. A new one needs task, milestone, model and effort; status, report, tokens and the rest are optional. */
declare function worker(id: string, fields: { name?: string; task?: string; skill?: string; model?: "opus" | "sonnet" | "haiku" | "fable"; effort?: "low" | "medium" | "high" | "xhigh" | "max"; status?: "blocked" | "done" | "failed" | "queued" | "running" | "stopped"; milestone?: string; report?: string; tokens?: number; duration_ms?: number; rounds?: number }, base?: OpId): LogDraft;
/** Add a step to milestone, or move the step with that id (its status in place). */
declare function step(milestone: string, id: string, title: string, status: "blocked" | "current" | "done" | "pending", agent?: string): LogDraft;
declare function milestone(id: string, title: string): LogDraft;
/** A card's fields: kind is decision, input, secret, action, grill, notice, permission or rule; title and question are required. */
type Card = { kind: string; title: string; question: string; options?: { id: string; label: string; consequence: string }[]; recommend?: string; reason?: string; why?: string; blocking?: boolean; agent?: string; asks?: "user" | "manager" } | PermissionCard | RuleCard;
/**
 * A permission card: the owner allows the exact calls once each, and the office host writes one exact rule per call
 * into root's .claude/settings.local.json (an Agent's into .claude/tstack-grants.json); each rule goes once its call
 * ran, any left after 30 minutes. tool is Bash or Agent; call is the exact command (an Agent's, its tool input as
 * JSON), with no *, |, backslash or newline, at most 2000 characters; then holds the further Bash commands, granted
 * with it, at most 10 calls in all; root is the absolute folder of the session that runs them, which must be a
 * workspace of this fleet or a --root of the office host. The card's options are set for you: allow-once,
 * allow-kind ("Allow once and save this kind": it grants exactly as allow-once does, and marks the card
 * kind_requested; not on an Agent spawn, not with once: true), and deny. An allow-kind answer asks you for a
 * RuleCard (below). A command the fleet can run is a permission, never an action card for the owner to run.
 */
type PermissionCard = { kind: "permission"; title: string; question: string; tool: "Bash" | "Agent"; call: string; then?: string[]; root: string; why?: string; blocking?: boolean; agent?: string; once?: boolean };
/**
 * A rule card, after an allow-kind answer: rule is ONE autoMode.allow entry for that kind of command, drafted in the
 * style of the entries already in ~/.claude/settings.json (what is allowed, bounded by literal paths and
 * subcommands, then "Not covered: ..."), reviewed by a fresh Opus agent that attacks its bounds, its fixes applied.
 * question says in one plain line what it lets every agent do without asking; why names the cards it came from and
 * the review's verdict. The page shows rule verbatim; the options are set for you: add-rule ("Add this rule": the
 * office host appends it to autoMode.allow in the owner's real ~/.claude/settings.json) and deny ("Not now"). The
 * fold refuses the rules the CLI refuses (SKILL.md, "Allow once and save this kind"; the two repos share rule-card.cases.json).
 */
type RuleCard = { kind: "rule"; title: string; question: string; rule: string; why: string; blocking?: boolean; agent?: string };
declare const decision: {
  /** Open a card the cloud numbers by its kind's letter (D219, P40, ...): the applied result's key is its id. */
  open(fields: Card): LogDraft;
  /** Open a card under an id of your own. */
  open(id: string, fields: Card): LogDraft;
  decide(id: string, answer: string, resolution: string): LogDraft;
};
declare function event(kind: "spawned" | "reported" | "blocked" | "resolved" | "asked" | "decision" | "note" | "integrated" | "reviewed", text: string, options?: { agent?: string; important?: boolean; decision?: string }): LogDraft;
declare function keep(text: string, id?: string): LogDraft;
/** Set one of the fleet's own fields: now, goal, status ("blocked" | "done" | "paused" | "running") and the like. */
declare function set(field: "now" | "now_at" | "goal" | "status" | "workspace_mode", value: string | null): LogDraft;
/** A chat line to the owner; re answers message #re. */
declare function say(text: string, options?: { re?: number; decision?: string; to?: string[] }): LogDraft;
```

A new worker needs `task`, `milestone`, `model` and `effort` (MODELS.md); the fleet refuses one without them, as the
CLI did. Its `status` is optional: a new worker starts `running`, as the CLI's `agent` did. The CLI's verbs map to these: `agent` to `worker`, `step` to `step`, `decision` to `decision.open` and
`decision.decide` (a `--kind permission` to `decision.open` with `kind: "permission"`, `tool`, `call`, `then` and
`root`), `event` to `event`, `keep` to `keep`, `milestone` to `milestone`, `set` to `set`, and
`chat … say` to `say`.

## Seven worked calls

Each is the body of one `FLEET_DIR=<dir> fleet-run <<'EOF' … EOF`. The test `scripts/tests/test_fleet_programs.py`
runs them, in this order, through the fleet's real prelude and fold.

A worker's report, its step done and the next one started:

```ts
worker("w1", { status: "done", report: "Login form done; tests green", tokens: 41200, duration_ms: 912000 });
step("m1", "s2", "Login form", "done", "w1");
step("m1", "s3", "Session store", "current", "w2");
return records.apply(ops);
```

A decision opened for the user, with no id: the cloud numbers the card by its kind's letter (D for a decision, P for a
permission), and the `applied` result's `key` is its id, `D219` say. Name that id in the event and the chat line that
follow, in the next program. `decision.open(id, fields)` opens a card under an id of your own, which you rarely need:

```ts
decision.open({ kind: "decision", title: "Where sessions live",
  question: "Which store keeps the login sessions?",
  options: [{ id: "kv", label: "Workers KV", consequence: "cheap; a logout takes up to 60 s to reach every edge" },
            { id: "do", label: "A Durable Object", consequence: "one writer per session; logout is immediate" }],
  recommend: "do", reason: "an immediate logout is the security requirement", blocking: true });
return records.apply(ops);
```

A decision decided (an answer the user gave in the session, or a grilling you closed):

```ts
decision.decide("D219", "do", "A Durable Object per session: logout must be immediate.");
event("decision", "D219: sessions live in a Durable Object", { decision: "D219" });
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

A read, before a write that must not overwrite another's change:

```ts
return records.read({ decisions: "open" });
```

Then pass the row's `op` as the `base` of the write that depends on it, for example
`worker("w2", { status: "stopped" }, "<op of w2's row>")`.

## What stays on the old CLI

Reads and the commands that are not the ledger: `fleet chat <dir> watch --as coordinator --all --resume --once` (the
wake, unchanged), `fleet state <dir> show`, `fleet brief`, `fleet ws <dir> list` and a dry-run `fleet ws <dir> prune`,
`fleet preview`, `fleet advisor`, `fleet turn`,
and the gate slot, `fleet fleets gate run`. Evidence bodies (`decision --body`) have no program: keep the evidence in
the decision's `why` and `reason`, or in a page you publish and link from the chat line.

`fleet ws <dir> add`, `split` and `prune --apply` write the ledger's workspace rows, which a moved team's ledger does
not keep, so they are refused. Make a worker's workspace with jj beside the repo's default workspace,
`jj workspace add <repo>-<name> -r @- --name <name>`, and name the path in the brief. When the repo has
`.fleet/ws-pre-add`, run it first, in the default workspace, and make nothing if it fails; when it has
`.fleet/ws-add <workspace> <default workspace>`, run it after. Give both the environment `fleet ws` gives its
hooks (FLEET_EVENT, FLEET_WS_ID, FLEET_WS_NAME, FLEET_WS_PATH, FLEET_WS_PORT, empty for a workspace made by
hand, FLEET_REPO, FLEET_FLEET: fleet/SPEC.md, Lifecycle hooks). `fleet preview <dir>` records its workspace and server in the ledger too, so only
`preview status` runs on a moved team.
