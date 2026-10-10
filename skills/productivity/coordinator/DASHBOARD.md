# Fleet dashboard

The dashboard is the user's window into the fleet and the coordinator's ledger, from one file: `state.json`. The state CLI (`fleet state`) is the only way you touch it: one command per event, which validates the change and renders the page. The page itself is a fixed template, never rewritten by hand. `fleet` is the plugin's CLI, `${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet`, run by the path [SKILL.md](SKILL.md) gives it.

## Where things live

- **Decisions' evidence**: `<scratchpad>/coordinator/decisions/<id>.html`, one HTML fragment per decision that has one, copied there by `fleet state <dir> decision --body` (see [Decisions](#decisions)).
- **Chat**: `<scratchpad>/coordinator/chat.jsonl`, the conversation between the user and the fleet, appended only through the page and `fleet chat` (see [Chat](#chat)).
- **Brief**: `<scratchpad>/coordinator/brief.md`, what every worker reads before its task, written by `init` from [assets/brief.md](assets/brief.md) with this fleet's paths. It is yours to add to, and no command overwrites it.
- **State**: `<scratchpad>/coordinator/state.json`, created and changed only through `fleet state` (below). [assets/example-state.json](assets/example-state.json) shows a filled-in state for reference.
- **Render**: done by every `fleet state` command. `fleet render <state.json> <out.html> --fragment` renders by hand, and the only reason to is the Artifact tool (below).
- **Publish**: put the fleet on the machine's hub, once per session: `fleet serve <scratchpad>/coordinator`. The hub is one server per machine that is always running (the `fleet-hub` user service): it serves every fleet of the machine at one address, `http://<magicdns-name>:7420/`, whose index lists every fleet on this machine and on the user's other machines that run a hub, and this fleet's page at `…/f/<fleet>/`, which the command prints. A fleet registers and appears; nothing else starts. Once served, the fleet's name (its id on the hub, or any unique part of it) stands for its directory in every `fleet` command, so the user can type `fleet preview ui start`; `fleet ls` lists the served fleets, and the user's `fleet tell <fleet|all> "…"` reaches this chat from their terminal as their own words. Give the user the URL once. Every later state change reaches the page on its own: the hub streams each change of `state.json` and each chat message to it, and the page re-renders in place, filters intact. `fleet serve <scratchpad>/coordinator --stop` takes the fleet off when the session ends. When the command says no hub runs on this machine, ask the user to start it (`systemctl --user start fleet-hub`). On a machine without the service, run the hub as a background command of your session (`fleet hub`, `run_in_background: true`) and tell the user it lasts as long as the session. A hub already serving is left alone, and the service takes the port back when it starts.
  If the user asks for a claude.ai artifact instead (no tailnet on their device), render with `fleet render <scratchpad>/coordinator/state.json <scratchpad>/coordinator/dashboard.html --fragment` and publish it with the Artifact tool (`icon: "chart"`, a one-sentence `description`), republishing the same path after every state change; open viewers receive each republish without reloading. An artifact has no server behind it, so it shows the fleet and has no chat: the decisions are listed and readable, and the user answers them in the session. Publish each decision's evidence beside the page, under the path the page asks for (`files: {"decisions/d1.html": "<scratchpad>/coordinator/decisions/d1.html"}`).

## State schema

Every list is ordered as the user should read it. Timestamps are ISO 8601 with a timezone.

```
role         manager, in a manager's ledger (absent in a coordinator's)
project      string   repo or project name
goal         string   the user's ask in one sentence
status       running | paused | blocked | done
now          string   one line: what is happening right now
started      ISO      when coordination began
updated      ISO      set by the render script

roadmap[]    ordered milestones
  id, title
  steps[]    id, title, status (done | current | pending | blocked), agent (agent id or null)

agents[]     one row per worker, in spawn order (its position picks its chart colour, so append, never reorder)
  id         short stable id, also used in steps/roadblocks/events
  name       what the user calls it ("auth-impl")
  name_by    who named it: user (on the page), coordinator (`--name`), session (its Agent call); absent while the name is the id
  task       one sentence
  skill      implement | diagnosing-bugs | prototype | research | tdd | none
  model      opus | sonnet | haiku | fable
  effort     low | medium | high | xhigh | max: the thinking effort it is spawned at (`fleet brief` prints it beside
             the model). Without --model or --effort a new row takes its skill's pair: research sonnet medium, any
             other opus high. A pair outside the role table (haiku low or high, sonnet low-high, opus
             medium-high, fable high; xhigh and max on none) is recorded with a warning, the user's to approve. Absent on a row
             recorded before efforts were: unset, and the brief then names no effort
  status     queued | running | blocked | done | failed | stopped
  lane[]     files or globs the worker may edit
  milestone  milestone id
  tokens     integer, from the task notification: the worker's total so far (0 until the first one)
  rounds     integer: 1, plus one each time the worker is sent back after a report
  duration_ms integer, same source
  started, updated   ISO
  brief      the completion criterion given to the worker
  report     the latest report, verbatim or condensed

roadblocks[]
  id, title, detail
  agent      agent id or null
  severity   warning | serious | critical
  needs      user | coordinator | worker
  decision   decision id: what the user is asked, required when needs is user
  since      ISO
  resolved   boolean

decisions[]  what waits on the user, in the order they were opened
  id         short stable id ("d1"), also the page's address (#decision/d1)
  kind       decision (pick an option) | input (give a value) | secret (say where it lives) | action (do it by hand)
             | notice (done under a standing approval: closed at once, asks nothing)
  title      the row's label
  question   one sentence
  why        what it blocks, or the assumption the fleet runs on meanwhile
  blocking   boolean
  options[]  id, label, consequence (kind decision)
  recommend  an option's id, or the value you would give; reason says why
  secret     the key the code expects (kind secret)
  manual     the route by hand (kind secret and action): short prose, and every command in a fenced block
             tagged with its language (nu on Luiz's machines: he runs nushell): commands that run in
             one go in one block, a new block only where Luiz acts between steps (reads output,
             decides, approves in 1Password); the page highlights each block and gives it a copy button.
             One with no fence shows as one nu block when its every line is a command, else as plain text
  body       boolean: decisions/<id>.html holds the evidence
  agent      the worker that waits on it, or null
  supersedes the closed decision this one replaces, or null
  asks       user | manager: who looks at it first
  status     open | decided | withdrawn
  answer     what was chosen or given (decided)
  resolution how it closed
  change     what the last revision changed
  page       false for a decision recorded after the fact
  advised    the advisor's view in one line, or none:<why no advisor was asked> (optional)
  under, undo  a notice's: the approval it was done under, and how to undo it
  opened, revised, closed   ISO

approvals[]  the standing approvals the user gave once (absent until the first)
  id, rule   its id (K1: K and a number) and what it covers, in the user's words
  by         who gave it
  ref        the decided decision where the user gave it: its id, or FLEET/<number> (manager/G5) when it is in
             another fleet's ledger; message, author: the chat message of the answer, in that fleet's chat
  question   q<n>: the grilling's question the user answered with a plain yes (absent for a decision or input)
  status     active | revoked; added, revoked, revoked_why

events[]     activity log, oldest first
  at         ISO
  agent      agent id or null (coordinator events)
  kind       spawned | reported | blocked | resolved | asked | decision | note | integrated | reviewed
  text       one or two sentences
  findings, changes   a reviewed event's: how many findings, and the jj change ids it read (land-check looks them up)
  decision   decision id the event is about (optional); the page opens it from the event
  important  kept in the log (optional); the page notifies as important only what is about a decision open for the user
```

## The state CLI

`fleet state <scratchpad>/coordinator <command>`. Create and update share a verb: an unknown id with its required fields creates the row, a known id changes only the fields given. Timestamps are stamped for you, ids you reference are checked, and every command renders.

| Event | Command |
| :-- | :-- |
| A manager's intake | `init --role manager --project P --goal G`, then `milestone landings --title "Landings and deploys"` |
| Intake done | `init --project P --goal G`, then `milestone m1 --title T` and `step s1 --milestone m1 --title T` per step, then `event --kind decision "why the split"` for anything non-obvious |
| Worker about to be spawned | `agent a1 --task T --skill tdd --milestone m1 --lane src/x.ts test/x.test.ts --step s1 --brief "done when ..."` (model and effort default by skill: research sonnet medium, any other opus high; `--model M --effort E` to choose; logs the spawn, marks the step current, prints the line its brief opens with) |
| Its brief | `fleet brief <dir> a1` prints the part the row holds (opening line, task, criterion, skill and how to load it, lane, workspace and its rules of history, step, chat id); you add the context below it |
| Its workspace | the lane's idle one: `fleet ws <dir> add a1 --reuse a0` (hands it over once a0 is done or stopped, records who held it); a fresh one only for parallel work that could meet, a risky experiment or a comparison: `fleet ws <dir> add a1 [-r BASE]` |
| The workers share one working copy (an expensive setup, disjoint lanes) | `set --workspaces shared` (`isolated` is the default): `fleet ws add` makes nothing, `agent` refuses a running lane that meets a live one, and each finished worker is integrated by `fleet ws <dir> split a1 -m "<description>"` |
| A worker's changes are in the stack, gates green | `fleet ws <dir> prune --apply` for its workspace, unless the lane's next worker reuses it |
| UI workers are running: the user sees their work live, merged | `fleet preview <dir> start [--cmd "<dev command>"] [--port N]` (once the fleet is served): a `preview` workspace whose @ merges on the stack the running workers' working copies and every other worker's not yet integrated (in neither the stack nor trunk(): a done worker shows until its work lands), the repo's dev server there (`--cmd`, else `fleet preview <dir> set --cmd "..."`, else package.json's `dev`; Vite and Vite+'s `vp dev` are told their port and base; when the server dies at start, `start` exits 1 with its log's last error) and an updater that takes each worker's edits every `FLEET_PREVIEW_S` seconds (3); give the user the printed `/f/<fleet>/preview/` link |
| The preview: who is in it, what conflicts, why it does not build | `fleet preview <dir> status` (address, workers and their commits, conflicted files and the workers that touch each, the dev server's last error); `include a1` / `exclude a1` take a worker in or out (the page's boxes do the same) |
| One worker's UI alone | `fleet preview <dir> start --per-worker a1`: a dev server in a1's own workspace, at `/f/<fleet>/preview/a1/`, no merge |
| The app only runs at its root (it calls `/api/...` absolutely, so under `/f/<fleet>/preview/` its pages load and its data calls 404) | Root mode: `fleet preview <dir> set --root` once (or `start --root`, `start --per-worker a1 --root`). The dev server is told `--base /` and the hub serves the preview at the root of a public port of its own (7500-7599, `FLEET_PREVIEW_PORTS`), kept across restarts; `start` and `status` print `https://<magicdns name>:<port>/`: give the user that link. The hub serves it with this machine's Tailscale certificate; without one it opens no port and `status` says `the hub cannot serve https on port N: <reason>`. The dev server stays on loopback; the hub passes the identity it verified and `X-Forwarded-Prefix: /` |
| The default workspace is the user's own checkout (its @ holds their uncommitted work), so the merge conflicts with "the stack" | Name the stack you integrate into: `fleet preview <dir> set --stack devloop@` (a bookmark or `<workspace>@`, resolved at every look, so it follows as it moves; `start --stack <revset>` for one start; `set --no-stack` goes back to the default workspace's @). It must name exactly one commit, else `status` gives the updater's error and the last good merge stays. `status` names it: `stack: devloop@ (<commit>)`. A done worker whose changes are in that stack drops out of the merge |
| The dev server needs secrets | Only through the environment: wrap `start` in any loader that runs a command with secrets in its environment, `secretspec run -- fleet preview <dir> start …` or `op run --env-file=<file of op:// references> -- fleet preview <dir> start …` (references only, never values), each start and each restart of a dead server; every dev server the preview starts inherits that environment. When secretspec's 1Password provider cannot reach the desktop app (`connecting to desktop app … timed out`), `op run --env-file` is the fallback. Never write or copy a secret file (`.dev.vars`) |
| The preview is no longer needed | `fleet preview <dir> stop` stops the combined preview and its updater and leaves per-worker previews running; `--per-worker a1` stops that one; `--all` stops everything. Its workspace stays for the next start, and `fleet ws <dir> prune --apply` removes it once nothing runs there (never while it runs) |
| Notification arrives | `agent a1 --status done --tokens N --duration-ms N --report "..." --step s1 --log "what it verified"` (the step follows the status; the log becomes a `reported` event; tokens are the worker's total so far) |
| Worker sent back after its report | `agent a1 --status running --step s1 --log "sent back: ..."` (counts a new round) |
| Worker blocked | `roadblock r1 --title T --detail D --severity serious --needs coordinator --agent a1` (marks the worker blocked, logs it) |
| Worker blocked on the user | the decision first, then `roadblock r1 ... --needs user --decision d1`; closing the decision clears the roadblock |
| Roadblock cleared | `roadblock r1 --resolved` (worker back to running, logs it) |
| Something needs the user | `decision d1 --kind decision --title T --question Q --why W --option "A: label \| consequence" --option "B: ..." --recommend A --reason R` (see [Decisions](#decisions)) |
| Your own choice, for the record | `event --kind decision "split the adapter out of m2: its interface is contested"` |
| A step's words or place changed | `step s2 --title "..."`, `step s2 --before s1` (or `--after`); `step s2 --remove "why"` takes out one recorded in error and logs the reason |
| A stack was reviewed before landing | `event --kind reviewed --findings N --changes "<change id>,..." "what was reviewed, with what"`: both required for that kind, refused on any other; `land-check` looks the change ids up |
| Milestone checks pass | `step s2 --status done` for any step not already done, `event --kind integrated "checks green"`, `set --now "..."` |
| The user must see something now | open a decision for it: the page chimes and keeps a toast only for what asks the user something still open. Everything else is the fleet's record, which the user sees only when their page is set to notify about everything |
| A worker is spawned | `agent a1 --task ... --milestone m1 --task-id <agentId>`: with the id the Agent tool returned, its tokens and duration are read from its own transcript on every command, so a finished worker's figures need no copying |
| A worker's name | Leave `--name` out: with `--task-id` the row takes what its session calls it (the Agent call's `name`, else its `description`) and follows it. `--name N` is yours and nothing automatic replaces it (`--name ""` gives it back to the session); a name the user gives on the page outranks both. The fleet takes its session's name (a /rename, else Claude Code's own, derived or not), unless the user names it on the page |
| Something must outlive a compaction and has no row (a queued ask, a hunk outside any lane, a workspace and what it holds, where a worker stands) | `keep ID "text"`; `keep ID --drop "why"` when it is settled. `show` prints them, and the Plan view lists them as held for later |
| A round of questions to settle a design (a grilling) | `grill g1 --title T --ask "TITLE \| QUESTION \| RECOMMENDATION \| WHY" --option "Q1 a: label \| what that means for you" --option "Q1 b: ..."`, one `--ask` per question and two to four `--option` for each (numbered in the order asked: a new grilling's questions are Q1, Q2, ...; a later round's go on from the last), RECOMMENDATION an option's id and WHY one plain sentence (written as in [SKILL.md](SKILL.md#grillings-and-links)); `--body FILE` the context every question shares, with its picture (shown once, above the first question, as The context); `--title`, `--why`, `--body` on an open grilling revise it, with `--log "what changed"`; the old four-part `--ask` with no options still works, and the page reads its "(a) ...; (b) ..." into cards; `--of Q2` for follow-ups; `--answer "Q3: ..."`, `--drop "Q4: why"`, `--revise "Q3: T \| Q \| R \| W"`, `--reason "Q3: why"` as answers come; `--done "what was agreed"` as soon as none is open (until then the page shows it in Waiting as answered, waiting to be recorded, and `fleet state` warns at every command). The page asks each question like a small decision, and one send carries every answer. Refused: a recommendation that is not one of the question's options, one option alone. Warned: a reason over 200 characters or whose first sentence holds a source (`store.ts:5-9`, `ADR-0024`, `D27`), a consequence over 160, more than four options, a worker's id or name from the ledger |
| Where a decision or a grilling came from | `--step S` (its milestone follows), `--milestone M`, `--agent A` on `decision` or `grill`; a closed one takes `--step`/`--milestone` too. The decision's page says "From <milestone>, step <step>, for <worker>", and the Plan shows the chips |
| A place built for the user: the live app, a prototype round, a doc, a tool, a lab | `link ID --url U --title T --kind preview\|prototype\|doc\|tool\|service [--for "what the user does there"] [--decision D] [--note N]`: the title in plain words, no worker id (warned); one `preview` per fleet, its live app; `--for` or an open `--decision` puts it under Needs you; `link ID --done` when it ends (it moves to Inactive), `--reopen` if it comes back, `--drop "why"` only for one recorded by mistake. Without `--kind` the CLI picks the kind the address reads as and says so |
| A step whose id you would otherwise invent | `step next --milestone M --title T` records it under the next free id and prints it |
| A heavy check on the shared machine (a full test suite or a whole test tier in any repo, a full or scoped gate, a full build) | Every worker's too, with the Vitest pool capped: two at once ran the machine out of memory and the reaper killed every fleet's chat watch (2026-10-08 18:20). One test file or a targeted run needs none. Take the slot before it and free it after; seeing `fleet fleets gate` say free is not enough, since another session can take it first. `fleet fleets gate take <fleet> "what" --wait 1800` (a session or worker that serves no fleet: `--as <its name>` in place of `<fleet>`) waits until the slot is free, takes it, and prints a token; `fleet fleets gate free <token>` after, pass or fail. While the slot is held, a take refuses, even from the fleet that holds it, and names the holder, its label and since when. A hold lapses after 60 minutes (`--for MINUTES` for a longer run) |
| Workers were paused, stopped, or ended unseen | `park "why"` (or `park --agent a1 --agent a2 "why"`): every live row stops in one command, with one log line. Every command warns while rows still say running in a paused or done fleet |
| Session ends | `set --status done --now "..."` (names the decisions still open and the workspaces not pruned) |
| Before a landing, with a manager | `fleet turn <dir>`: exit 0 when the manager gave this fleet the turn (or no manager is served); `land-check` runs it too |

`show` prints the ledger as text, and under it every command with the values it takes: the place to look after a compaction. Add `--no-render` to any command when several follow in a row, and let the last one render.

## Fleets and the manager

`fleet serve` records the fleet in a registry on this machine and forgets it on `--stop`. A fleet is known there by a name made from its project (`acme-billing`; a second fleet of the same project is `acme-billing-2`). `fleet fleets`:

| Command | What it does |
| :-- | :-- |
| `list` | every fleet being served: its name, role, status, session, page, directory and what it is doing, then its queued, running and blocked agents (each with its first lane and `+N`), its links, its open decisions and what it spent |
| `show FLEET` | what one fleet is doing, from its ledger: its now-line, live workers and their last reports, every lane in flight (`lane <glob>  <agents>`, one per line), open decisions and roadblocks, the latest events |
| `manager` | how to reach the manager (its session, its page, `standing.md`); exits 1 when there is none |
| `decision FLEET ID` | what a fleet asks, in full, with where its evidence and its page are |
| `name DIR SESSION` | gives the fleet its one name, the session's (`ListAgents` gives it): the registry, the manager's page and chat, and `SendMessage` all use it. Run it again after the session is renamed, and call the fleet by that name in what you write |

A ledger made with `init --role manager` is a manager's. Its page is sent every coordinator being served, its chat is hosted by `manager` and mentions the coordinators by their fleet's name (their workers stay in their own fleet's chat), its steps name the coordinator whose turn it is, and its directory holds `standing.md`. A coordinator's page shows the way to the manager while one is being served. The user's message on the manager's page to a coordinator being served (`@<fleet>`) is delivered by the hub into that fleet's own chat, as the user's to `coordinator`, tagged `[via manager #N]` (`via` in the message); the manager's message records it (`[delivered to <fleet> #id]`) and the manager's watch leaves it out. The coordinator answers it in its own chat with `--re`, and the hub copies that answer onto the manager's page as the reply to #N. A fleet not served is not addressed: the message goes to the manager, which forwards it. What a coordinator does with a manager is in [SKILL.md](SKILL.md#with-a-manager).

**The news.** What a session tells the fleets that needs nobody to act now (a release note, an FYI, a rule change) is posted, never sent as a message: a message wakes the session it reaches, and each wake re-reads its whole context. `fleet news`:

| Command | What it does |
| :-- | :-- |
| `post --from NAME [--to all\|FLEET[,FLEET...]] [--kind release\|fyi\|rule] [--keep] TEXT` | appends a numbered item to the machine's `news.jsonl` (in the registry); `--to` names only the fleets it concerns; `--keep` marks a durable rule the reader saves, and the default is "do not save"; at most 1000 characters, a long part goes in a file named by path |
| `read --as FLEET` | prints what FLEET has not read (to all or to it, never its own) and moves its cursor |
| `list` | every item |

Nothing wakes on news. A fleet learns of its unread items from one line on stderr of every `fleet state` command, from the line its chat watch adds when it wakes for a real message, and from the plugin's SessionStart and Stop hooks. Read them with `read --as <your fleet>` between other work. An item marked `keep` goes where your fleet keeps rules (brief.md's "This fleet", or memo); `do not save` is read and dropped.

### What a coordinator itself spends

The ledger counts the workers' tokens as they report. What the coordinator spends on coordinating them is read from its session's transcript (`fleet spend <dashboard-dir>` prints it): the tokens it wrote, the tokens it read, and how much of that came from the cache. The page shows it beside the workers' tokens, and a manager's page shows it for every fleet. A session resumed under a new id writes to another transcript, which the figure does not follow.

### The plan's usage

A manager's page shows how full the plan's 5-hour and 7-day windows are and when each resets. The figures are the ones Claude Code hands a status line (`rate_limits`, for a subscription, after a session's first response), captured on the way through: the user's status line command in `settings.json` becomes `<the CLI's full path> usage capture -- <the command it had>`, which keeps the reading and runs the status line as it was. Every session on the machine runs the status line, and sessions may run under different logins, which the status line's input does not name, so a reading is kept per account: the one logged in to the session's config directory (`oauthAccount` in `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). The page shows the account whose session captured last, named, and a line for each other account still inside a window. `fleet usage show` prints what is held, account by account. `settings.json` is the user's: give them the line, and change it only on their word.

## Decisions

`fleet state <scratchpad>/coordinator decision ID ...` opens a decision with an unknown id and changes an open one with a known id. When to open one, and what goes in it, is in [SKILL.md](SKILL.md#decisions).

| Event | Command |
| :-- | :-- |
| A choice | `decision d1 --kind decision --title T --question Q --why W --option "A: label \| consequence" --option "B: label \| consequence" --recommend A --reason R` |
| An input | `decision d2 --kind input --title T --question Q --why W [--recommend VALUE --reason R]` |
| A secret | `decision d3 --kind secret --title T --question Q --why W --secret STRIPE_TEST_KEY --manual "cd servers/billing; secretspec set STRIPE_TEST_KEY"` |
| An action by hand | `decision d4 --kind action --title T --question Q --why W --manual '...'`, the text short prose and every command in a fenced block with its language (```` ```nu ```` for Luiz, who runs nushell), commands that run in one go in one block, a new block only where Luiz acts between steps (reads output, decides, approves in 1Password); the CLI refuses a manual of more than one line with no fence, and takes one bare command line as it is. Pass it in single quotes with real line breaks: inside double quotes the shell runs backticks. The page highlights each block and gives it a copy button; question, why, reason, consequences and chat messages take inline code and blocks too ("Text on the page" in fleet/SPEC.md) |
| A refused call | the plugin hook opens it as a `permission` (ref P) for a Bash command or an Agent spawn: the exact call, the classifier's reason, the rule, and the options `allow-once` and `deny`; a refused call of any other tool, or a Bash command no exact rule can hold, it opens as an `action` with the call to make by hand. By hand: `decision p1 --kind permission --title T --question Q --why W --tool Bash --call CALL --cause CAUSE --root ROOT [--agent-id AID] --agent a1 --blocking`. ROOT is the session's root (`$CLAUDE_PROJECT_DIR`), never a worker's workspace, for a subagent's call too: a subagent obeys only its session root's settings. The CLI records a worker's workspace of the fleet (in `workspaces[]`, or a jj workspace of the session's repo) as its session root and says so, or refuses when it cannot tell which. The hub grants only at a root a heartbeat of the fleet names or that the fleet's registered session (`fleet serve`'s pid) runs in; an older row naming a worker's workspace is granted at that session root, and the answer says where. A folder outside the fleet's work is refused: "This permission's folder … isn't part of this fleet's work, so it can't be granted here; ask the coordinator to record it again from its session." An `allow-once` answer makes the hub add the rule to `<root>/.claude/settings.local.json` and log it in `grants.jsonl`, stamped with who answered (`tailnet:<login>` or `local`); the hook removes the rule once the refused caller has run that call, or at the session's first tool call after 30 minutes. An Agent spawn (`--tool Agent --call` its input as compact JSON, keys sorted, as the hook records it) is granted the same way, into `<root>/.claude/tstack-grants.json`: auto mode drops `Agent` allow rules from the settings, so the plugin's PreToolUse hook lets that exact spawn through, and only a retry with the same input matches |
| It stops work | add `--blocking`; `--agent a1` names the worker that waits |
| A manager is present | add `--asks manager`: the manager looks first, and the user is not called. `decision d1 --asks user` passes it on, and calls them |
| The question | the ask alone, one or two plain sentences: over 400 characters is refused (`--question is N characters, M over the 400 ...`), and so is a `--why` over 400 (`--why is N characters, ...`); warned, not refused: over 300 with no body, a word from the jargon list (sha1, sha256, digest, stage cache, alias, uuid, idempotent, upsert, blob, enum, turn gate, gold, harness, rubric, Jev), a worker's id or name as the ledger records it (`b333`, `invoice-gen`) in the title, question or reason, a `--why` over 200, a consequence over 160, a grilling's question (`--ask`, `--revise`) over 300, parts or three amounts with no picture in the body (the show-me triggers), and "you decided", "you said", "you chose", "your rule", "as decided" or "you approved" with no decision number in the same sentence. Every decision number in a question, why, option or reason links to its decision on the page, its title, status, answer and date on hover or focus. Another fleet's is named with its fleet ("Infra's d172, question 2", by its number or id) and always links, to `#decision/<fleet>/<id>` on the manager's page; its tip is read from that fleet's ledger through the hub when first wanted. A stored question or why over the limit stays as it is until it is written again, and the page folds a why over 300 characters behind More |
| A nu command | a secret's or action's `--manual` with a ```` ```nu ```` block that does not parse in nushell is refused when `nu` is on PATH (`--manual's nu block N does not parse in nushell (nu-check --debug: <nu's reason>)`); bash in one (`&&`, `export X=`, `$(...)`, `2>&1`) is warned |
| Evidence | add `--body FILE`: an HTML fragment, copied to `decisions/<id>.html`; `--no-body` removes it. Required for a plan, several settings, numbers or a trade-off (its sections in [SKILL.md](SKILL.md#decisions)). The page shows it after the ask and before the recommendation and the options, as The details; one taller than the screen folds after its first part (In short, Why this needs you) with Show all the details |
| The facts changed | `decision d1 --why "..." --log "what changed"` with any field; stamps `revised`, and the page tells the user. The `--log` is one line, the history's line for it; a new question, options or manual with no `--log` is warned |
| The question changed | a choice's new `--question` comes with its options (`--option` again replaces them all, with `--recommend` and `--reason`), or with `--same-options` when the old ones still answer it |
| The user answered | `decision d1 --decide "B: Keep both shapes" --resolution "answered on the page (#14)"`: this command records the answer, and a reply in the chat alone leaves the decision waiting |
| The user's step failed (`Failed: <what happened>`) | not done, and `--decide` is refused: fix it, then `decision A1 --manual '...' --log "what changed"` re-presents it (the page lists it under Waiting with a red `failed: <first words>` pill until then); `--hold "the fix"` meanwhile, or `--withdraw "why"` |
| The fleet works on the answer first | `decision A1 --hold "fix the role cut first"`: records the answer, keeps the item open and off the user's list (the page shows it under Waiting, "With the fleet: ..."). A revision of the question, options or manual re-presents it and clears the hold, as do `--unhold` and closing |
| Nobody has to answer | `decision d1 --withdraw "the worker found the rule in the finance ADR"` |
| Changed after it closed | `decision d7 ... --supersedes d1` (a closed decision refuses every change) |
| The user approves a kind of act once | after the decision that asked is decided: `approval add K1 --rule "<what it covers, in the user's words>" --by luiz --ref D7`. Refused unless D7 is decided, a choice, input or grilling asked of the user on the page (not `--asks manager`, not recorded after the fact), with the user's answer to it in the chat; the row keeps that message's number and author. `approval list` prints them with the notices under each |
| An act done under an approval | `decision n1 --kind notice --under K1 --title T --question "what was done" --undo "how to undo it"` (`--why`, `--agent`, `--step`, `--milestone`, `--body` too): recorded decided at once (answer `done`, resolution `under K1`), numbered N, posted to the manager's news as an fyi (no item when no manager is served), listed on the page under Done under your approvals. Refused: an unknown or revoked approval, no `--undo`, and options, a recommendation, a secret, a manual, `--asks manager`, `--blocking`, `--advised` or a close |
| The user revokes an approval (Revoke on the page posts it to the chat) | `approval revoke K1 --reason "revoked on the page (#21)"`: a notice under it is refused from then on |
| The user approves a kind of act once for every fleet (a grilling on the manager's page, one yes/no question per rule) | in one fleet: `approval add K1 --rule "..." --by luiz --ref manager/G5:Q1`, the decision found through the registry and checked in that fleet's ledger and chat as above; a grilling is always named by its question, and the question must be answered yes or approve (its first word, an option key read as its label, "as recommended" as its recommendation), else it is refused with the answer found. In every fleet at once: `fleet fleets approval add --all --rule "..." --ref manager/G5:Q1 [--fleets a,b]`, each fleet's next K, one line per fleet (`infra: added K3`), a fleet that already has one from that ref skipped and named (`skipped, K2 already comes from ...`); exit 1 when a fleet refused |
| The user revokes a fleet-wide approval | `fleet fleets approval revoke --ref manager/G5:Q1 --reason "revoked on the page (#21)" [--fleets a,b]`: each fleet's active approval from that ref revoked, one line per fleet; `approval revoke K3` still revokes one fleet's alone |
| The advisor's view of a choice the user is asked | `--advised "<one line>"` or `--advised none:<why not>` on `decision`; warned when a choice or input goes to the user without it while the fleet has a live `advisor` row, or is the third choice (decisions, inputs, grillings) asked of the user today |
| Decided in the session or the chat | `decision d8 --title T --question Q --decide "yes" --resolution "said in the session"` (recorded closed, no page) |

**The page.** Each decision has a page at `<dashboard-url>#decision/<id>`, read top-down: the title; the question, large (one recorded before the 400-character rule shows its asking sentence large and the rest in reading type, in short paragraphs, its "(1) … (2) …" run as a list); what it blocks or what the fleet assumes meanwhile; the recommendation as a callout with its reason; the options as cards with their consequences, the recommended one marked; the conversation about it ("In the chat"); the body ("The details"); and the history, newest first, one line per moment (asked, each `--log`, held, the answers, decided), the earlier ones folded and each long one opening to its whole text. A decided one also offers Change my answer and Add to my answer (both start a message about it in the chat). Under the options sits the control for its kind (options to pick with a note, a field, a reference for a secret, Done and Failed buttons for an action, Failed with a note required on what happened). The user's answer posts to the chat tagged with the decision, and the page shows it as sent until you record it. A decision that was decided or withdrawn shows how, and takes no more answers: the server refuses one with the reason, so a page left open on a stale decision cannot answer it.

**The evidence** is a fragment, not a document: `<h2>` sections in the order SKILL.md gives, tables, inline SVG, and scripts or external libraries when a chart needs them. The page supplies the typography and the theme: each `<h2>` opens a ruled section, a table's head row is shaded and scrolls sideways on a phone, `<ol>` steps are numbered in the margin (the colours are CSS variables: `--text`, `--muted`, `--line`, `--card-2`, `--accent`, `--accent-soft`, `--good`, `--warning`, `--critical`, `--s1` to `--s8`; the classes `lead` for the In short paragraph, `callout`, `num`, `muted`, `good`, `warning`, `critical`). An SVG draws with these variables (`stroke="var(--line)"`), so it reads in both themes. It runs in a frame without the dashboard's origin, so a script in it can draw and cannot answer as the user. Its figures are a snapshot: say as of when, and replace the file with `--body` when they change.

**A secret's answer** is a 1Password reference or an item's name. The server refuses text that reads as a value (a known token prefix, a long word mixing letters and digits), so the value never reaches `chat.jsonl`.

## Chat

The page has a chat where the user writes to the fleet and mentions who should answer: `@coordinator`, or a worker by id or name, with autocompletion from the ledger. A reply also goes to whoever wrote the message it answers. A message with neither a mention nor a reply goes to the coordinator. The conversation is `chat.jsonl`, append-only and numbered; a message stays **open** for a recipient until that recipient answers it with `--re`, so a message you missed is still in your inbox and the page shows the user who it is waiting on.

`fleet chat <scratchpad>/coordinator <command>`:

| Command | What it does |
| :-- | :-- |
| `wait DECISION...` | waits for the user's answer to one of these decisions (ids or numbers), prints it and exits; armed as a background command when a decision is opened, it wakes the session the moment the user answers |
| `watch --as coordinator --all --resume --once` | prints one line per message from the user, whoever it is addressed to: first the open ones, at once, else the new ones as they land, then exits once they settle (below). `--resume` starts after the last line a `--once` watch of yours exited with (`--after N` names the number yourself). Without `--once` the watch never exits, so it is refused outside a terminal: a background command without it would never wake you. It also prints a `!` line for a worker silent twenty minutes, and for a message to a worker left unanswered ten minutes (forward that one by `SendMessage`) |
| `inbox --as WHO` | the messages open for `WHO`, oldest first |
| `say --as WHO [--re N] TEXT` | appends a message from `WHO`, answering message `N`; mentions in `TEXT` address other agents. An answer to the user without `--re` leaves their message open, unanswered on the page and to the manager: `say` then names the user's open messages on stderr |
| `log [--after N]` | the whole conversation |

**A watch settles before it exits.** What was open when it started prints and exits at once. A new line does not end it: the watch keeps printing what lands and exits once no line has come for 30 seconds, each new line restarting the wait, and never more than 120 seconds after the first. A message from the user to you settles in 10 seconds, so the user never waits long. A burst of worker messages and `!` lines is then one wake instead of one each: every wake re-reads your whole context. `--settle S` sets the 30 seconds for one watch, and `FLEET_WATCH_SETTLE`, `FLEET_WATCH_SETTLE_USER` and `FLEET_WATCH_SETTLE_MAX` set the three for every watch. `wait` (a decision's answer) still exits the moment the user answers. When the watch exits for a real line and the machine has news you have not read, it adds one line, `news: N unread for <fleet>, never a wake: ...`: read it when convenient ([Fleets and the manager](#fleets-and-the-manager), the news).

**Arm the watch** right after starting the server, as a background Bash command (`run_in_background: true`): `fleet chat <dashboard-dir> watch --as coordinator --all --resume --once`. It waits without costing anything, and exits with the first messages that land, which wakes you with them, also when you are idle. Handle them, then arm the same command again: `--resume` starts after the last line printed, so nothing is missed or shown twice. Give it `timeout: 3300000` (55 minutes): a background command is stopped at its timeout (30 minutes by default), which wakes you with nothing to handle; re-arm it and wait again. Under an hour the wake reads the cached context (the prompt cache lasts an hour), so 55 minutes halves the quiet wakes at no extra cost per wake, while a longer timeout lets the cache lapse and each wake pays for the whole context again. The plugin's hook enforces it: a turn that ends with no `--once` watch running goes on with the command to arm it, and mid-turn, after a tool call, it tells you of a message or an answer that has waited three minutes. Hand long hands-on work to workers, so your turns stay short and the user's messages reach you while they are fresh.

Arm it only as a background command of the session (`run_in_background: true`), never as a shell job (`... & disown`) and never with its output redirected (`>/dev/null`). A detached watch still reads the user's message and moves the cursor when it exits, but what it prints goes nowhere and its exit wakes no one: the message counts as read, so neither the page nor the manager warns, and nobody answers it. The watch refuses to run with its stdout on /dev/null.

With a manager, its watch reads your fleet's chat and ledger itself (`watch --fleets`): the user's answers and messages on your page, and your decisions opened for the user, decided, withdrawn or held, reach it directly. Record an answer in your ledger; do not relay it to the manager.

A running `--once` watch keeps its process id in `DIR/watch-coordinator.pid` (a second watch is refused while the first runs; the page also finds a running watch whose pid file is gone), and what it exited with, handed to you as it woke you, is what was read. So the page tells the user when nobody reads the chat and marks each of their messages "Not read yet" until a watch prints it; every `fleet state` command prints a `chat:` warning on stderr while the user's messages wait unread; and a manager is told after two minutes, and reaches you with `SendMessage`; it is told too of a message of the user's to you that has gone ten minutes with no reply carrying `--re`, read or not. On that warning, arm the watch: it prints what waited first. A fleet with nothing running still keeps its watch armed: the watch is how the user reaches you.

**Who may write.** Text typed on the page lands in agents' contexts, so the server names the sender. The hub lets only the tailnet login that owns this machine post (it asks Tailscale who each request comes from; this machine itself may post too), and the message records it as `author`, printed in every line from the user (`#12 user (luiz@github) -> a1 (auth-impl): ...`). Only the server writes as the user: `say --as user` is refused. Agents name themselves with `--as`, so a line from an agent is that agent's word and carries no authority of the user's. A message in the chat is the user speaking: it carries the authority of the same words typed in the session, and the same limits, so a destructive or outward-facing step asked for in the chat is confirmed before it runs.

**Posting from a prototype page.** A page served on another port of this machine (a prototype at `https://<machine>:7501/`) can post the user's message into a fleet's chat when its exact origin is listed in the hub's config, `<registry>/hub/config.json` (the registry is `$FLEET_HOME`, else `$XDG_STATE_HOME/fleet-board`, else `~/.local/state/fleet-board`), which Luiz edits by hand and the hub reads at each request:

```json
{"chat_origins": ["https://cr-sede-pc.dusky-tritone.ts.net:7501", "https://cr-sede-pc.dusky-tritone.ts.net:7504"]}
```

Each entry is the origin as the browser sends it: scheme, lower-case host and port, no path, no trailing slash, no wildcard. The page calls:

```js
const res = await fetch("https://cr-sede-pc.dusky-tritone.ts.net:7443/f/<fleet>/chat", {
  method: "POST",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
```

A 201 means the message is in the fleet's chat as the user's, exactly as if typed on the fleet's page (`@mentions` and `/skill` commands included), with `origin` set to the page's origin and printed `[from <origin>]`; it wakes the coordinator's watch. The body may also carry `re`, `quote` and `side` as the page's own composer does. Answering a decision (`decision`, `rule`) is refused from another origin (403): that stays on the fleet's page. Any other answer is an error the page can read (`{error}`, with the CORS headers): 403 not the owner's login or an origin not listed, 400 a bad body, 413 too big. A page whose post fails falls back to copying the text and opening the fleet's page. The hub's SPEC has the details (`fleet/SPEC.md`, Posting from a prototype page).

## What the page shows

The page is built for a phone first, one view at a time: Decisions, Plan, Fleet, Log, and the chat. A bar of labelled tabs sits under the thumb, each worker is a strip, and the chat is a full-height view that stays above the keyboard. On a wide screen the tabs are a row under the masthead, the fleet is a table, and the chat docks at the side. Each view has an address (`#decisions`, `#plan`, `#fleet`, `#log`, `#decision/<id>`), so a link you give the user opens where you mean.

- Masthead: the project, its status, the way to the manager's page when there is one, and the bell.
- Decisions, the view the page opens on: what waits on the user said in a sentence ("2 decisions wait on you. 1 of them blocks work."), the goal and the `now` line, then the decisions: open ones that block work first, then the other open ones, oldest first, then the closed ones with how they closed. A row is marked new until the user opens it and changed when it was revised since. Each row opens the decision's page. Under them, the fleet's totals: workers by status, steps done, tokens, elapsed time.
- Plan: the roadmap with the current step marked; steps link to their worker.
- Worker sheet: a worker's name anywhere on the page (a step, a roadblock, the fleet, the chart, the activity log, the chat) opens its task, lane, round, brief, and report, with a button that starts a message to it.
- Plan, too: the roadblocks, open first, with who is needed and a link to the decision when it is the user.
- Fleet: the workers with filters (status, milestone, skill, model, free text; the model cell shows the effort beside it) and expandable brief and report, and the token chart: one bar per worker, coloured by spawn order, with its share of the total.
- Log: the activity, newest first, filtered together with the table.
- On a manager's page, under the totals: the plan's usage of the account whose session worked last, named, one meter per window, with when it resets and how old the reading is; below, a line for each other account still inside a window.
- On a manager's page: Decisions lists the manager's own and, from every fleet, the ones that wait on the user. A fleet's opens on the manager's own page at `#decision/<fleet>/<id>`, as that fleet's decision page in a frame (`/f/<fleet>/?embed=1#decision/<id>`: the decision alone, answered into that fleet's chat). Every decision's page there steps to the previous and next of what waits on the user, in the list's order, and once one is answered goes on to the next, focused, saying which was answered (Previous goes back to it); with nothing next, or with the switch "Go to the next once answered" turned off (it is on until the user turns it off, and the browser keeps the choice), it stays and says which comes next. The Fleet tab reads Fleets and lists the coordinators: what each is doing, its workers by status, what waits in it, its lanes in flight, and the way to its page. A coordinator's name opens its sheet, with a button that starts a message to it.
- Chat: the conversation in threads, each reply under the message it answers. The user's message shows who it is waiting on until each recipient has answered. The composer completes `@` from the roster, and `/` at the start of any word from the skills the session can run (so does a decision's note or answer), and says who the message will reach. A `/<skill>` anywhere in the user's message is the user typing that command (the coordinator's SKILL.md, "Respond"). A viewer who may not write sees the conversation with the reason in place of the composer.
- Links: the places the fleet named, filtered Active (the default), Inactive or All, by kind, and on a manager's page by fleet. "Needs you" first (tied to an open decision, or with a `--for`), then the active ones by kind (live preview, prototypes, tools, docs, services), then the inactive ones folded (done, its decision closed, its server down, its file gone). Each row: the kind's badge, the plain title, the fleet, what the user does there, "up · checked 20:31" or "down since 18:02" (the hub probes each address on this machine and the tailnet over HTTP, 3 s, every minute; an address elsewhere is not probed), and its port or host (":7501 preview"). A row recorded as `dev` reads as a preview and one as `page` as a doc, unless its address is a claude.ai artifact (a doc) or says prototype (a prototype). A `file://` link in the dashboard dir or the session's scratchpad (or the fleet's own state dir) opens through the hub at `/f/<fleet>/files/...`, so it opens on a phone; any other file reads "only on this machine". Then what the machine serves through `tailscale serve` that no link names, with the process, its directory, and the fleet that started it (found from its parent processes, else from the first transcript that wrote its address). A manager's page lists every fleet's. `fleet served` prints the same.
- Stuck: at the top of every page, an answer the fleet has had for five minutes without recording it (a reply in the chat does not record an answer; only the decision command does), and a chat nobody reads while the user's messages wait there; on the manager's page, every fleet's.
- One address: the hub serves every fleet's page at `/f/<fleet>/` and the manager's at `/f/manager/` (each page with its chat, its decisions and its live stream), and every page's header has a switcher between the manager and the fleets. Each page keeps its browser storage (drafts, what was read) under its own path.
- Numbers: every decision, link and roadblock has one, given when it is recorded and kept: D a choice, A an action, I an input, S a secret, G a grilling, N a notice, K a standing approval, L a link, R a roadblock (D3, A1, K1, L2). An approval's number is its id, given with `approval add K<n>` (the CLI refuses any other); the page links K3 to the approval. The page shows them, the chat's lines carry them (`[D3 d-cuts]`), and every command takes one in place of the id, written in capitals (`decision D3 --decide ...`).
- Search: Ctrl/⌘K, or the magnifier in the header, finds anything the page holds (decisions and actions, links, roadblocks, plan steps, workers, coordinators on a manager's page, chat messages, the log) and goes there. A number (`D3`) comes first; `d`, `l`, `r`, `p`, `w`, `c`, `f` and a space look in one group.
- An answer sent counts at once: the item leaves "waits on you" when the user sends it, and comes back only when the fleet revises it (new words, a new command, a new grilling round); a reply in the chat does not bring it back, nor record it. Record it as soon as the watch prints it, before other work: decide it, or hold it (`--hold`) while the fleet does what it needs first. A held item sits under Waiting with the reason and the time held, and is never stuck.
- What waits is named by kind: "1 action waits on you", "1 decision and 1 action wait on you", "3 things wait on you" for three kinds or more, on the page's first line, the Decisions tab's tooltip and each fleet's facts on the manager's page; a stuck answer reads "action answered, not recorded".
- Selected text: selecting any text on the page, a decision's evidence included, shows Reply (the excerpt goes on the composer as a quote) and Side chat (a conversation of its own about the excerpt, folded in the main chat as one line until opened). The message carries the quote as `quote: {text, from, at}` and a side chat's messages carry `side`: the opener's id. `at` is where the text was: the page's address (`#decision/d1`, `#plan`), the part of it (`anchor`), or the chat message (`message`); in the chat the quote's "From ..." is then a link back there that opens the place, scrolls to it and marks the quoted text for a moment (a message in the chat, in its side chat), and on a phone closes the chat over the page. A quote from before has no `at` and shows its label as text. Lines print them as `(quoting <from>: "...")` and `[side chat #N]`; a reply with `--re` to a side chat's message stays in it. On the manager's page, text selected in a fleet's decision (shown there in a frame) offers the same bar, and Reply and Side chat address that fleet's coordinator (`@<fleet>`) with the quote from `<where>, in <fleet>` at the manager's address of that decision (`#decision/<fleet>/<id>`); the hub delivers it into that fleet's chat, a side chat as a side chat there, its link to the fleet's own decision page (`#decision/<id>`), or, for a place on the manager's page, to the manager's page.
- Side chats, organised: Side chats, in the chat's tools, shows every side chat in the chat's place, newest activity first, the last hour's at the top: its first line, the item it is about (the decision its quote was taken on, else where the quote is from), how long ago it last moved and the answers not read in it. A search reads every message of each; a filter keeps one item's. Archive (on a row, or in the side chat's head) moves one to the Archived view until something new is said in it; what is archived and read is kept in this browser (`side-archived`, `side-read`), as the chat's other choices are, since the chat stores messages only. Back to the chat, and a side chat opened again, return to where each was scrolled.
- Asking about an item: a decision's, action's or grilling's page offers Ask in the chat and Side chat, the same composer as Reply and Side chat on the whole item: the quote's text is its question, `from` its ref and title (`D1 Rounding rule for totals`), `at` its page (`#decision/d1`, anchor `dv-info`), and the chip on the composer links back there. The message carries no `decision` (that would make it an answer): it prints as `(quoting D1 Rounding rule for totals: "...")`; answer it about that item, with `--re`. Change my answer is the same ask, starting with "I want to change my answer." The item's page shows these messages, their side chats and the replies in its thread. Inside the manager's frame the manager's composer asks, to `@<fleet>`, as Reply does there.
- A grilling's page: its title, how many questions are left, The context (its body, once, folded when long), then the open questions, each like a small decision: its title, the question in plain size, its options as cards with the recommended one marked, the reason as a callout (its first lines, the rest behind More, its sources in parentheses folded under Sources), and a field for the user's own words (a note to the option picked, or an answer of its own); Later leaves it for another send. A question asked before options shows its "(a) ...; (b) ..." as cards, its stored words unchanged. A follow-up sits under what it follows and names it. What was sent and waits to be recorded; what is settled, folded away. One send carries every answer, an option as `Q1: a: <label> (as recommended). <note>`.
- A decision's page reads top-down: the ask, the why (headed What it blocks, Meanwhile, or Why this needs you, by what it says), The details, the recommendation with its reason, the options and the answer, then the conversation and the history.
- Notifications: by default only what is for the user: what asks them something still open, and every message from the fleet while the chat is out of view; "Notify about: everything the fleet does" in the panel adds every event. Important (a chime, a toast that stays) is only what asks them something still open, whatever flag an event carries. One about a decision opens its page. A bell in the top right carries the unread count and opens the list, with mark-read, clear, and the sound and toast preferences. New events show as one toast (under the masthead on a phone, clear of the tabs): the newest that needs the user, with how many more arrived, so they never stack. A tap opens what it is about, or the list when it stands for several. Important ones stay until dismissed, chime, and flag the tab title. Browsers allow sound only after the viewer has clicked the page once, so a viewer who never interacts still gets the toast and the badge. Browser alerts (system notifications while the tab is hidden) are a third preference in the panel; they need the https address and a permission the viewer grants when turning them on, and important ones stay on screen until dismissed.

Filters and the expanded rows survive each re-render (the page keeps them in the viewer's browser), so the user's view is not reset by your updates.
