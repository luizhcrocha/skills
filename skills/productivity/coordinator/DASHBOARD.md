# Fleet dashboard

The dashboard is the user's window into the fleet and the coordinator's ledger, from one file: `state.json`. The state CLI is the only way you touch it: one command per event, which validates the change and renders the page. The page itself is a fixed template, never rewritten by hand.

## Where things live

- **Decisions' evidence**: `<scratchpad>/coordinator/decisions/<id>.html`, one HTML fragment per decision that has one, copied there by `state.py decision --body` (see [Decisions](#decisions)).
- **Chat**: `<scratchpad>/coordinator/chat.jsonl`, the conversation between the user and the fleet, appended only through the page and `scripts/chat.py` (see [Chat](#chat)).
- **Brief**: `<scratchpad>/coordinator/brief.md`, what every worker reads before its task, written by `init` from [assets/brief.md](assets/brief.md) with this fleet's paths. It is yours to add to, and no command overwrites it.
- **State**: `<scratchpad>/coordinator/state.json`, created and changed only through `scripts/state.py` (below). [assets/example-state.json](assets/example-state.json) shows a filled-in state for reference.
- **Render**: done by every `state.py` command. `scripts/render_dashboard.py` is what it calls, and the only reason to run it directly is `--fragment` for the Artifact tool.
- **Publish**: put the fleet on the machine's hub, once per session: `<skill-dir>/../../../fleet/bin/fleet serve <scratchpad>/coordinator` (the plugin's `fleet` CLI). The hub is one server per machine that is always running (the `fleet-hub` user service): it serves every fleet of the machine at one address, `http://<magicdns-name>:7420/`, whose index lists every fleet on this machine and on the user's other machines that run a hub, and this fleet's page at `…/f/<fleet>/`, which the command prints. A fleet registers and appears; nothing else starts. Give the user the URL once. Every later state change reaches the page on its own: the hub streams each change of `state.json` and each chat message to it, and the page re-renders in place, filters intact. `fleet serve <scratchpad>/coordinator --stop` takes the fleet off when the session ends. When the command says no hub runs on this machine, ask the user to start it (`systemctl --user start fleet-hub`); until then, or on a machine without the service, the fallback until the cutover is the old per-fleet server: `python3 <skill-dir>/scripts/serve_dashboard.py <scratchpad>/coordinator` (its own port behind `tailscale serve`, https; `--stop`, `--restart`).
  If the user asks for a claude.ai artifact instead (no tailnet on their device), render with `--fragment` to `dashboard.html` and publish it with the Artifact tool (`icon: "chart"`, a one-sentence `description`), republishing the same path after every state change; open viewers receive each republish without reloading. An artifact has no server behind it, so it shows the fleet and has no chat: the decisions are listed and readable, and the user answers them in the session. Publish each decision's evidence beside the page, under the path the page asks for (`files: {"decisions/d1.html": "<scratchpad>/coordinator/decisions/d1.html"}`).

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
  task       one sentence
  skill      implement | diagnosing-bugs | prototype | research | tdd | none
  model      opus | sonnet | haiku | fable (haiku is outside the policy: recorded with a warning, the user's to approve)
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
  title      the row's label
  question   one sentence
  why        what it blocks, or the assumption the fleet runs on meanwhile
  blocking   boolean
  options[]  id, label, consequence (kind decision)
  recommend  an option's id, or the value you would give; reason says why
  secret     the key the code expects (kind secret)
  manual     the route by hand: steps or commands, shown verbatim (kind secret and action)
  body       boolean: decisions/<id>.html holds the evidence
  agent      the worker that waits on it, or null
  supersedes the closed decision this one replaces, or null
  asks       user | manager: who looks at it first
  status     open | decided | withdrawn
  answer     what was chosen or given (decided)
  resolution how it closed
  change     what the last revision changed
  page       false for a decision recorded after the fact
  opened, revised, closed   ISO

events[]     activity log, oldest first
  at         ISO
  agent      agent id or null (coordinator events)
  kind       spawned | reported | blocked | resolved | asked | decision | note | integrated
  text       one or two sentences
  decision   decision id the event is about (optional); the page opens it from the event
  important  kept in the log (optional); the page notifies as important only what is about a decision open for the user
```

## The state CLI

`python3 <skill-dir>/scripts/state.py <scratchpad>/coordinator <command>`. Create and update share a verb: an unknown id with its required fields creates the row, a known id changes only the fields given. Timestamps are stamped for you, ids you reference are checked, and every command renders.

| Event | Command |
| :-- | :-- |
| A manager's intake | `init --role manager --project P --goal G`, then `milestone landings --title "Landings and deploys"` |
| Intake done | `init --project P --goal G`, then `milestone m1 --title T` and `step s1 --milestone m1 --title T` per step, then `event --kind decision "why the split"` for anything non-obvious |
| Worker about to be spawned | `agent a1 --task T --skill tdd --milestone m1 --lane src/x.ts test/x.test.ts --step s1 --brief "done when ..."` (model defaults to opus; logs the spawn, marks the step current, prints the line its brief opens with) |
| Its brief | `<skill-dir>/../../../fleet/bin/fleet brief <dir> a1` prints the part the row holds (opening line, task, criterion, skill and how to load it, lane, workspace, step, chat id); you add the context below it |
| Notification arrives | `agent a1 --status done --tokens N --duration-ms N --report "..." --step s1 --log "what it verified"` (the step follows the status; the log becomes a `reported` event; tokens are the worker's total so far) |
| Worker sent back after its report | `agent a1 --status running --step s1 --log "sent back: ..."` (counts a new round) |
| Worker blocked | `roadblock r1 --title T --detail D --severity serious --needs coordinator --agent a1` (marks the worker blocked, logs it) |
| Worker blocked on the user | the decision first, then `roadblock r1 ... --needs user --decision d1`; closing the decision clears the roadblock |
| Roadblock cleared | `roadblock r1 --resolved` (worker back to running, logs it) |
| Something needs the user | `decision d1 --kind decision --title T --question Q --why W --option "A: label \| consequence" --option "B: ..." --recommend A --reason R` (see [Decisions](#decisions)) |
| Your own choice, for the record | `event --kind decision "split the adapter out of m2: its interface is contested"` |
| A step's words or place changed | `step s2 --title "..."`, `step s2 --before s1` (or `--after`); `step s2 --remove "why"` takes out one recorded in error and logs the reason |
| Milestone checks pass | `step s2 --status done` for any step not already done, `event --kind integrated "checks green"`, `set --now "..."` |
| The user must see something now | open a decision for it: the page chimes and keeps a toast only for what asks the user something still open. Everything else is the fleet's record, which the user sees only when their page is set to notify about everything |
| A worker is spawned | `agent a1 --task ... --milestone m1 --task-id <agentId>`: with the id the Agent tool returned, its tokens and duration are read from its own transcript on every command, so a finished worker's figures need no copying |
| Something must outlive a compaction and has no row (a queued ask, a hunk outside any lane, a workspace and what it holds, where a worker stands) | `keep ID "text"`; `keep ID --drop "why"` when it is settled. `show` prints them, and the Plan view lists them as held for later |
| A round of questions to settle a design (a grilling) | `grill g1 --title T --ask "TITLE \| QUESTION \| RECOMMENDATION \| WHY"`, one `--ask` per question, the reason required; `--of Q2` for follow-ups; `--answer "Q3: ..."`, `--drop "Q4: why"`, `--revise "Q3: T \| Q \| R \| W"`, `--reason "Q3: why"` as answers come; `--done "what was agreed"` when none is open. The page asks each question with its recommendation, and one send carries every answer |
| Where a decision or a grilling came from | `--step S` (its milestone follows), `--milestone M`, `--agent A` on `decision` or `grill`; a closed one takes `--step`/`--milestone` too. The decision's page says "From <milestone>, step <step>, for <worker>", and the Plan shows the chips |
| A dev server or a page built for the user | `link ID --url U --title T --kind dev\|page [--decision D] [--note "what to do there"]`; `--drop "why"` when it stops |
| A step whose id you would otherwise invent | `step next --milestone M --title T` records it under the next free id and prints it |
| A heavy check on the shared machine (a test suite under load, a full build) | `fleets.py gate take <fleet> "what"` before, `fleets.py gate free <fleet>` after; while another fleet holds it, `take` refuses and names the holder |
| Workers were paused, stopped, or ended unseen | `park "why"` (or `park --agent a1 --agent a2 "why"`): every live row stops in one command, with one log line. Every command warns while rows still say running in a paused or done fleet |
| Session ends | `set --status done --now "..."` (names the decisions still open and the workspaces not pruned) |
| Before a landing, with a manager | `fleet turn <dir>`: exit 0 when the manager gave this fleet the turn (or no manager is served); `land-check` runs it too |

`show` prints the ledger as text, and under it every command with the values it takes: the place to look after a compaction. Add `--no-render` to any command when several follow in a row, and let the last one render.

## Fleets and the manager

`fleet serve` (or the fallback `serve_dashboard.py`) records the fleet in a registry on this machine and forgets it on `--stop`. A fleet is known there by a name made from its project (`acme-billing`; a second fleet of the same project is `acme-billing-2`). `python3 <skill-dir>/scripts/fleets.py`:

| Command | What it does |
| :-- | :-- |
| `list` | every fleet being served: its name, role, session, status, address, directory, what it is doing, its lanes in flight, its open decisions |
| `manager` | how to reach the manager (its session, its page, `standing.md`); exits 1 when there is none |
| `decision FLEET ID` | what a fleet asks, in full, with where its evidence and its page are |
| `name DIR SESSION` | gives the fleet its one name, the session's (`ListAgents` gives it): the registry, the manager's page and chat, and `SendMessage` all use it. Run it again after the session is renamed, and call the fleet by that name in what you write |

A ledger made with `init --role manager` is a manager's. Its page is sent every coordinator being served, its chat is hosted by `manager` and mentions the coordinators by their fleet's name (their workers stay in their own fleet's chat), its steps name the coordinator whose turn it is, and its directory holds `standing.md`. A coordinator's page shows the way to the manager while one is being served. What a coordinator does with a manager is in [SKILL.md](SKILL.md#with-a-manager).

### What a coordinator itself spends

The ledger counts the workers' tokens as they report. What the coordinator spends on coordinating them is read from its session's transcript (`python3 <skill-dir>/scripts/spend.py <dashboard-dir>` prints it): the tokens it wrote, the tokens it read, and how much of that came from the cache. The page shows it beside the workers' tokens, and a manager's page shows it for every fleet. A session resumed under a new id writes to another transcript, which the figure does not follow.

### The plan's usage

A manager's page shows how full the plan's 5-hour and 7-day windows are and when each resets. The figures are the ones Claude Code hands a status line (`rate_limits`, for a subscription, after a session's first response), captured on the way through: the user's status line command in `settings.json` becomes `python3 <skill-dir>/scripts/usage.py capture -- <the command it had>`, which keeps the reading and runs the status line as it was. Every session on the machine runs the status line, so the reading follows whichever session worked last. `python3 <skill-dir>/scripts/usage.py show` prints what is held. `settings.json` is the user's: give them the line, and change it only on their word.

## Decisions

`state.py <scratchpad>/coordinator decision ID ...` opens a decision with an unknown id and changes an open one with a known id. When to open one, and what goes in it, is in [SKILL.md](SKILL.md#decisions).

| Event | Command |
| :-- | :-- |
| A choice | `decision d1 --kind decision --title T --question Q --why W --option "A: label \| consequence" --option "B: label \| consequence" --recommend A --reason R` |
| An input | `decision d2 --kind input --title T --question Q --why W [--recommend VALUE --reason R]` |
| A secret | `decision d3 --kind secret --title T --question Q --why W --secret STRIPE_TEST_KEY --manual "cd servers/billing; secretspec set STRIPE_TEST_KEY"` |
| An action by hand | `decision d4 --kind action --title T --question Q --why W --manual "the steps or commands"` |
| It stops work | add `--blocking`; `--agent a1` names the worker that waits |
| A manager is present | add `--asks manager`: the manager looks first, and the user is not called. `decision d1 --asks user` passes it on, and calls them |
| Evidence | add `--body FILE`: an HTML fragment, copied to `decisions/<id>.html`; `--no-body` removes it |
| The facts changed | `decision d1 --why "..." --log "what changed"` with any field; stamps `revised`, and the page tells the user |
| The question changed | a choice's new `--question` comes with its options (`--option` again replaces them all, with `--recommend` and `--reason`), or with `--same-options` when the old ones still answer it |
| The user answered | `decision d1 --decide "B: Keep both shapes" --resolution "answered on the page (#14)"` |
| Nobody has to answer | `decision d1 --withdraw "the worker found the rule in the finance ADR"` |
| Changed after it closed | `decision d7 ... --supersedes d1` (a closed decision refuses every change) |
| Decided in the session or the chat | `decision d8 --title T --question Q --decide "yes" --resolution "said in the session"` (recorded closed, no page) |

**The page.** Each decision has a page at `<dashboard-url>#decision/<id>`: the question, what it blocks or what the fleet assumes meanwhile, the recommendation, the evidence, and the control for its kind (options to pick with a note, a field, a reference for a secret, a done button). The user's answer posts to the chat tagged with the decision, and the page shows it as sent until you record it. A decision that was decided or withdrawn shows how, and takes no more answers: the server refuses one with the reason, so a page left open on a stale decision cannot answer it.

**The evidence** is a fragment, not a document: headings, tables, inline SVG, and scripts or external libraries when a chart needs them. The page supplies the typography and the theme (the colours are CSS variables: `--text`, `--muted`, `--line`, `--accent`, `--good`, `--warning`, `--critical`, `--s1` to `--s8`; the classes `num`, `muted`, `good`, `warning`, `critical`). It runs in a frame without the dashboard's origin, so a script in it can draw and cannot answer as the user. Its figures are a snapshot: say as of when, and replace the file with `--body` when they change.

**A secret's answer** is a 1Password reference or an item's name. The server refuses text that reads as a value (a known token prefix, a long word mixing letters and digits), so the value never reaches `chat.jsonl`.

## Chat

The page has a chat where the user writes to the fleet and mentions who should answer: `@coordinator`, or a worker by id or name, with autocompletion from the ledger. A reply also goes to whoever wrote the message it answers. A message with neither a mention nor a reply goes to the coordinator. The conversation is `chat.jsonl`, append-only and numbered; a message stays **open** for a recipient until that recipient answers it with `--re`, so a message you missed is still in your inbox and the page shows the user who it is waiting on.

`python3 <skill-dir>/scripts/chat.py <scratchpad>/coordinator <command>`:

| Command | What it does |
| :-- | :-- |
| `wait DECISION...` | waits for the user's answer to one of these decisions (ids or numbers), prints it and exits; armed as a background command when a decision is opened, it wakes the session the moment the user answers |
| `watch --as coordinator --all [--resume] [--once]` | streams one line per message from the user, whoever it is addressed to: first the open ones, then each new one as it lands. `--resume` starts after the last line a watch of yours printed (`--after N` names the number yourself); `--once` exits after the first lines it prints. It also prints a `!` line for a worker silent twenty minutes, and for a message to a worker left unanswered ten minutes (forward that one by `SendMessage`) |
| `inbox --as WHO` | the messages open for `WHO`, oldest first |
| `say --as WHO [--re N] TEXT` | appends a message from `WHO`, answering message `N`; mentions in `TEXT` address other agents |
| `log [--after N]` | the whole conversation |

**Arm the watch** right after starting the server, as a background Bash command (`run_in_background: true`): `python3 <skill-dir>/scripts/chat.py <dashboard-dir> watch --as coordinator --all --resume --once`. It waits without costing anything, and exits with the first messages that land, which wakes you with them, also when you are idle. Handle them, then arm the same command again: `--resume` starts after the last line printed, so nothing is missed or shown twice. A background command has no deadline, so a quiet chat costs no turns. (The Monitor tool also works, without `--once`, but a monitor expires every 30 minutes and each expiry costs a turn.)

A running watch keeps its process id in `DIR/watch-coordinator.pid`, and what it printed is what was read. So the page tells the user when nobody reads the chat and marks each of their messages "Not read yet" until a watch prints it; every `state.py` command prints a `chat:` warning on stderr while the user's messages wait unread; and a manager is told after two minutes, and reaches you with `SendMessage`. On that warning, arm the watch: it prints what waited first. A fleet with nothing running still keeps its watch armed: the watch is how the user reaches you.

**Who may write.** Text typed on the page lands in agents' contexts, so the server names the sender. Behind `tailscale serve` only the tailnet login of this machine's user may post, and the message records it as `author`, printed in every line from the user (`#12 user (luiz@github) -> a1 (auth-impl): ...`). Only the server writes as the user: `say --as user` is refused. Agents name themselves with `--as`, so a line from an agent is that agent's word and carries no authority of the user's. On the plain-http fallback the chat is read-only. A message in the chat is the user speaking: it carries the authority of the same words typed in the session, and the same limits, so a destructive or outward-facing step asked for in the chat is confirmed before it runs.

## What the page shows

The page is built for a phone first, one view at a time: Decisions, Plan, Fleet, Log, and the chat. A bar of labelled tabs sits under the thumb, each worker is a strip, and the chat is a full-height view that stays above the keyboard. On a wide screen the tabs are a row under the masthead, the fleet is a table, and the chat docks at the side. Each view has an address (`#decisions`, `#plan`, `#fleet`, `#log`, `#decision/<id>`), so a link you give the user opens where you mean.

- Masthead: the project, its status, the way to the manager's page when there is one, and the bell.
- Decisions, the view the page opens on: what waits on the user said in a sentence ("2 decisions wait on you. 1 of them blocks work."), the goal and the `now` line, then the decisions: open ones that block work first, then the other open ones, oldest first, then the closed ones with how they closed. A row is marked new until the user opens it and changed when it was revised since. Each row opens the decision's page. Under them, the fleet's totals: workers by status, steps done, tokens, elapsed time.
- Plan: the roadmap with the current step marked; steps link to their worker.
- Worker sheet: a worker's name anywhere on the page (a step, a roadblock, the fleet, the chart, the activity log, the chat) opens its task, lane, round, brief, and report, with a button that starts a message to it.
- Plan, too: the roadblocks, open first, with who is needed and a link to the decision when it is the user.
- Fleet: the workers with filters (status, milestone, skill, model, free text) and expandable brief and report, and the token chart: one bar per worker, coloured by spawn order, with its share of the total.
- Log: the activity, newest first, filtered together with the table.
- On a manager's page, under the totals: the plan's usage, one meter per window, with when it resets and how old the reading is.
- On a manager's page: Decisions lists the manager's own and, from every fleet, the ones that wait on the user, each opening on its fleet's page. The Fleet tab reads Fleets and lists the coordinators: what each is doing, its workers by status, what waits in it, its lanes in flight, and the way to its page. A coordinator's name opens its sheet, with a button that starts a message to it.
- Chat: the conversation in threads, each reply under the message it answers. The user's message shows who it is waiting on until each recipient has answered. The composer completes `@` from the roster and says who the message will reach. A viewer who may not write sees the conversation with the reason in place of the composer.
- Links: the pages and dev servers the fleet named (up or down, each opening in a new tab), and what the machine serves through `tailscale serve` that no link names, with the process, its directory, and the fleet that started it (found from its parent processes, else from the first transcript that wrote its address). A manager's page lists every fleet's. `served.py` prints the same.
- Stuck: at the top of every page, an answer the fleet has had for five minutes without recording it, and a chat nobody reads while the user's messages wait there; on the manager's page, every fleet's.
- One address: a manager's server also serves each fleet's page at `/f/<fleet>/` (the page, its chat, its decisions and its live stream, passed through to the fleet's own server after the manager's server checks the post), and every page's header has a switcher between the manager and the fleets. On the manager's page the fleets' links go there; a fleet's page keeps its own address as well. Each page keeps its browser storage (drafts, what was read) under its own path.
- Numbers: every decision, link and roadblock has one, given when it is recorded and kept: D a choice, A an action, I an input, S a secret, G a grilling, L a link, R a roadblock (D3, A1, L2). The page shows them, the chat's lines carry them (`[D3 d-cuts]`), and every command takes one in place of the id, written in capitals (`decision D3 --decide ...`).
- Search: Ctrl/⌘K, or the magnifier in the header, finds anything the page holds (decisions and actions, links, roadblocks, plan steps, workers, coordinators on a manager's page, chat messages, the log) and goes there. A number (`D3`) comes first; `d`, `l`, `r`, `p`, `w`, `c`, `f` and a space look in one group.
- An answer sent counts at once: the decision leaves "waits on you" when the user sends it, and comes back only when the fleet replies to the answer. Record it as soon as the watch prints it, before other work, so the fleet acts on it and the page says it is decided.
- Selected text: selecting any text on the page, a decision's evidence included, shows Reply (the excerpt goes on the composer as a quote) and Side chat (a conversation of its own about the excerpt, folded in the main chat as one line until opened). The message carries the quote as `quote: {text, from}` and a side chat's messages carry `side`: the opener's id. Lines print them as `(quoting <from>: "...")` and `[side chat #N]`; a reply with `--re` to a side chat's message stays in it.
- A grilling's page: the open questions, each with its recommendation and the reason for it, and a choice (take it, answer in your own words, or later), follow-ups under what they follow; what was sent and waits to be recorded; what is settled, folded away.
- Notifications: by default only what is for the user: what asks them something still open, and every message from the fleet while the chat is out of view; "Notify about: everything the fleet does" in the panel adds every event. Important (a chime, a toast that stays) is only what asks them something still open, whatever flag an event carries. One about a decision opens its page. A bell in the top right carries the unread count and opens the list, with mark-read, clear, and the sound and toast preferences. New events show as one toast (under the masthead on a phone, clear of the tabs): the newest that needs the user, with how many more arrived, so they never stack. A tap opens what it is about, or the list when it stands for several. Important ones stay until dismissed, chime, and flag the tab title. Browsers allow sound only after the viewer has clicked the page once, so a viewer who never interacts still gets the toast and the badge. Browser alerts (system notifications while the tab is hidden) are a third preference in the panel; they need the https address and a permission the viewer grants when turning them on, and important ones stay on screen until dismissed.

Filters and the expanded rows survive each re-render (the page keeps them in the viewer's browser), so the user's view is not reset by your updates.
