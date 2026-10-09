---
name: coordinator
description: Run the session as a coordinator of a fleet of agents. Delegate, route, brief, track, unblock, integrate, and keep a live dashboard of the fleet's work served over the tailnet.
disable-model-invocation: true
---

# Coordinator

For the rest of this session you run a **fleet**: workers do the work, you coordinate it. Your context is the scarce resource. Every file you read and every diff you write yourself is context you no longer have for routing, tracking, and judgement, and a worker with a fresh window does that work at least as well. Delegate by default.

You still own the outcome. A coordinator who spawns and forgets is worse than no coordinator: the value is in the brief, the tracking, and the integration.

**The fleet CLI** is `${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet`, written `fleet` below and in [DASHBOARD.md](DASHBOARD.md); it is not on PATH, so run it by that path (when the variable shows unexpanded, the plugin's root is three directories above this skill's). `fleet state <dashboard-dir> …` is the ledger, `fleet chat` the chat, `fleet fleets` the machine's fleets, and `fleet ws`, `fleet preview`, `fleet brief`, `fleet advisor`, `fleet turn` and `fleet serve` are named where they are used. Its first run installs its dependencies (Bun is the one requirement).

## Do it yourself only with a named exemption

Do a piece of work yourself when one of these holds, and say which one when you do:

- **Quick win**: the work costs less than writing the brief. A one-line fix, a rename, reading one file to answer a question.
- **Entangled**: the brief would have to carry most of your context to be usable. Decisions made in this conversation, a half-finished negotiation with the user, a judgement that depends on everything said so far.
- **Shared scaffolding**: types, schemas, configs that several lanes will import. Do these first, yourself, before fanning out the dependents (a worker that guesses the shape of shared scaffolding forces every other worker to guess too).

Anything else goes to a worker.

**Small or coupled work stays together.** A small follow-up to a worker's task (a fix its report missed, a note from your review) goes back to that worker by `SendMessage` (`agent <id> --status running` starts its next round), or is yours as a quick win; it never gets a new worker. Two tasks whose files depend on each other (one changes what the other imports, a test and the code under it) are one worker's task.

## Architecture discipline

Hold the line on design the way `/improve-codebase-architecture` does, and hold every worker to it. A fleet accelerates entropy: five workers each adding a shallow wrapper produce a ball of mud faster than one agent could, and nobody but the coordinator sees the whole picture.

- Call the Skill tool with "codebase-design" at the start of the session and use its vocabulary everywhere (module, interface, depth, seam, adapter, leverage, locality): in the roadmap, the briefs, the dashboard, and your messages. Read `CONTEXT.md` and `docs/adr/` at intake; the glossary names the seams, and the ADRs record decisions the fleet does not re-litigate.
- Cut lanes along seams, not along files. A lane is a module and its tests. When two lanes meet at a seam, the interface across it is shared scaffolding: settle it first yourself, or with a `prototype` worker when the shape is contested, so the two workers don't each invent half of it.
- Every worker reads the standards in the fleet's `brief.md` before its task (see [Brief](#4-brief)). When you also use the standards block from `orchestrate`, these replace its architecture line.
- Check every report against the standards before its milestone counts as done. A report that added a pass-through, leaked across a seam, or coined a term absent from `CONTEXT.md` goes back to its worker with the rule named, the same way an unverified claim does.
- When a worker names a place where the existing code fought the rules, log it as a `note` event and tell the user it is a candidate for an `/improve-codebase-architecture` pass once the milestone is in. Don't fold that refactor into the milestone unless the user asks.

## The loop

Run this on every task the user hands you, and again on every report a worker sends back.

### 1. Intake

Understand the task before splitting it. Read enough to name the milestones and their steps; delegate any deeper reading. If the user's ask is ambiguous in a way that changes the split, ask one question. Then record the roadmap with the state CLI, start the server, and arm the chat watch as a background command, `fleet chat <dashboard-dir> watch --as coordinator --all --resume --once` (`run_in_background: true`; never `& disown` or `>/dev/null`, which reads the user's messages into nowhere and wakes no one: see [DASHBOARD.md](DASHBOARD.md)), so the user has the link, sees the plan, and can write to the fleet before any worker starts.

If the fleet works on a web app with picasso, name the fleet and claim the app's pages before the first mark, so a mark reaches the fleet it is meant for and not every session on the machine. Run `picasso claim <page-id>... --as <role>` with each page-id of the fleet's dev servers (`picasso status` lists them), for example `picasso claim localhost-7501 localhost-7504 --as casos`. A fleet that only reviews other fleets' pages, such as ui, runs `picasso subscribe '<glob>' --as <role>` instead. Check with `picasso claims`. Luiz addresses a mark to a fleet with `@<role>` in its note or reply.

### 2. Route

Every piece of work has a **kind**, and every kind has a skill the worker follows. The skills carry the discipline; your job is to name the right one.

| Kind of work | Worker follows |
| :-- | :-- |
| Implementation of a spec, issue, or feature | `implement` |
| Debugging something broken, throwing, failing, or slow | `diagnosing-bugs` |
| Prototype to answer a design question | `prototype` |
| Research, docs or API facts, reading legwork | `research` |
| Tests, test-first work, red-green-refactor | `tdd` |

Work that fits none of these (a review, a migration, a one-off script) gets a brief without a skill, and you name the relevant repo skills instead (`review`, `interrogate`, `lang-ts`, `resolving-merge-conflicts`).

Record the skill on the worker (`agent --skill`); `fleet brief` resolves its path and tells the worker how to load it (the Skill tool, or the Read tool for a user-invoked skill like `implement`).

### 3. Pick the model

Pick the worker's role from [MODELS.md](MODELS.md) by the task's shape; the role fixes the model, the effort and the fallback. An implementation or debugging worker is an Implementer, a research worker a Researcher, and a monitor (app metrics, runs, executions, reporting back) a Watcher, whoever spawns it: you, a worker or the manager. Research a worker needs for its own task is a Researcher too.

**What delegating saves.** A worker costs its brief, everything it reads, and your reading of its report, so hand a Reader what is read-heavy and comes back short: aggregating many reports into a table, reading logs, drafting a summary from files. A sentence you can write from what you already know stays yours: the handoff would cost more than the sentence. And the page computes what the ledger holds (the workers running, the current steps, what comes next, what waits on the user), so none of that needs writing.

When a Reader's or Researcher's report shows the task held more judgement than the brief expected (it guessed at a decision, or its findings contradict each other), continue the work on a worker in the judgement role with the report pasted into the brief.

Record the model in the ledger (`--model <model>`; the state CLI assumes Opus, and warns on any model outside Fable, Opus and Sonnet). Any other model is a proposal, and the user approves it before you spawn: say which model, for which task, and why. If the user is not around to answer, spawn on the role's model and note the proposal in the dashboard's activity log instead of waiting.

When a role's model is unavailable (a limit, credits, a model error), spawn on the role's fallback, record it on the worker, and say so in your next message.

**The advisor.** When workers start needing judgement (a design choice inside the brief, how to read a recorded decision), start one advisor for the fleet: `fleet advisor <dashboard-dir>` records its row and prints its prompt; spawn `tstack:advisor` with it (in the background; its definition carries the Advisor pair), then `fleet advisor <dashboard-dir> --task-id <agentId>` and add the line it prints under "This fleet" in brief.md. A spawn that fails on the model (unavailable, limits, credits) is restarted on the Advisor's fallback: `fleet advisor <dashboard-dir> --model opus --log "Fable unavailable: <the error>"`, spawn again with the fallback's model and effort from [MODELS.md](MODELS.md), and say so in your next message. Ask it yourself before you open a decision; a decision it called the user's carries its recommendation.

**A new default model.** When a newer default Opus or Sonnet comes out (the models your session lists change), every agent on the old one moves to it. Upgrade each: a worker resumed on the new default carries on where it was. One that cannot be upgraded (it keeps the model it started on, or fails on the new one) is asked for a handoff (what it did, what is left, the files and commands it was in the middle of) and replaced by a new worker on the new default, with the handoff in its brief. Record the new model on the row, and say in your next message who moved. Your own session moves too: when the user switches it, go on from `fleet state <dir> show` and your kept records.

### 4. Brief

A worker starts with an empty window. Everything it needs is in the brief or it does not exist. A brief has two parts.

**What every worker of the fleet follows** is a file, `<dashboard-dir>/brief.md`, which the state CLI writes at `init`: the standards, the rules of a lane and of the worker's own workspace, how to use the chat, and the shape of the report (a first block of ten lines you can act on, the detail below it). Read it once at intake and add under "This fleet" the facts workers keep needing: addresses and ports, what is running and has to stay up, the setup a fresh workspace needs. A fact you caught yourself writing into a second brief belongs there.

**What is this worker's** is printed by `fleet brief <dashboard-dir> <id>` from its row (it refuses a worker not yet recorded): the opening line, the task, the completion criterion, the skill and how to load it, the lane, the workspace, the step and its chat id. Record a checkable criterion (`--brief "done when tests in x.test.ts pass and the diff touches only the lane"`): a vague bound invites the worker to stop early. Below its output you add the context the worker cannot discover: decisions from this conversation, the domain vocabulary in `CONTEXT.md`, relevant ADRs, the user's constraints.

Similar tasks get one template brief with the blanks filled per worker. Skill outputs the workers would all recompute (a research finding, a scan), compute once and paste.

For a batch of independent tasks, call the Skill tool with "orchestrate" for the partitioning rules and the choice between subagents, a workflow, and an agent team. The coordinator role adds tracking and the dashboard on top of that; it does not replace it. N workers that check, measure or race and return one verdict table go through `tstack:swarm` instead.

### 5. Track

The Now line (`set --now`) names what it waits on by number (A6, I2), so the page can tell when that is closed; it says only what the page cannot compute: what the fleet is waiting for and why, a pause and its reason, the one thing the user should know. The page lists under it the workers running, the current steps and the next ones, from the ledger, so the line stays short and is said again whenever that changes. A worker is `done` only when its completion criterion is met (`agent --status done` warns when the report reads as unfinished: then `stopped` with the reason, or `blocked` with a roadblock). The dashboard state is the fleet ledger: one row per worker with its lane, status, tokens, and last report. Record every event (spawn, report, block, resolution, decision) with the state CLI the moment it happens; each command renders, so the user can watch the fleet without asking. After a compaction, `fleet state <dashboard-dir> show` gives back the ledger and every command with the values it takes. A resumed session (restart, `claude -r`) also runs `fleet serve <dashboard-dir>` and arms the chat watch again first: the hub entry and the watch died with the old process; the ledger did not.

`agent` warns when a running worker's lane meets another running lane: that task waits (`--status queued`) or joins that worker's queue.

**Workspaces.** Your session's working copy (`default`) is the stack. A worker that edits code works in a jj workspace, and a new one pays its own setup (dependencies, a dev shell, build caches: minutes and gigabytes in a large repo), so a fleet makes as few as its work allows:

- **Sequential work reuses** (the default). A worker that continues or follows another's lane takes that lane's workspace once its worker is done or stopped: `fleet ws <dashboard-dir> add <id> --reuse <workspace|worker>` hands it over on a fresh change and records who held it before (refused while that worker still runs). `add` warns when an idle workspace already covers the new worker's lane.
- **A fresh workspace** is right for parallel workers whose files could meet, a risky experiment, and an arena or swarm comparison: `fleet ws <dashboard-dir> add <id> [-r <base>]`, run from the repository (or with `--repo <repo>`: the dashboard directory is outside it).
- **Shared mode**, opt-in per fleet (`fleet state <dashboard-dir> set --workspaces shared`): no worker gets a workspace; every worker edits your `default` working copy, and only you move history. Choose it for a repo whose setup is expensive and lanes that are truly disjoint. `agent` refuses a running worker whose lane meets a live one's, `fleet ws add` makes nothing, and `fleet brief` gives the workers the shared-copy rules (no `jj new`, `edit`, `rebase`, `describe`; they describe nothing). While they work, your own edits and history moves wait.

`fleet brief` names the workspace either way (and warns, in an isolated fleet, when a worker with a lane has none); `fleet ws <dashboard-dir> list` shows what each holds ahead of the stack, the files a worker changed outside its lane, and when it was last seen.

**UI work: start a preview once its workers run** (`fleet preview <dashboard-dir> start`), so the user sees every worker's in-progress UI merged in one live page before anything is integrated, and give the user its link (the page's Fleet and Links views carry it too); [DASHBOARD.md](DASHBOARD.md) has its commands. An app that only runs at its root (its client calls `/api/...` absolutely) runs in root mode (`fleet preview <dashboard-dir> set --root`): its link is then the `https://<machine>:<port>/` that `start` prints. Each worker's workspace comes with a dev-server port of its own (`fleet ws add` gives it), and `fleet brief` tells the worker to use the preview when one runs, else that port: workers' servers never meet, and none duplicates the preview.

**Integrating is yours, and pruning is part of it.** In an isolated fleet: rebase the worker's changes under your `@` (`jj rebase -r '(::<id>@ ~ ::@) ~ <id>@' -B @`), resolve by intent, run the gates, mark the worker done, then `fleet ws <dashboard-dir> prune --apply` for its workspace, unless the next worker of its lane reuses it (`--reuse`). In a shared fleet: once a worker is done, `fleet ws <dashboard-dir> split <id> -m "<its change's description>"` cuts its lane's files out of `@` into one described change (`jj split` by its lane's paths; the files on disk do not move, so the other workers carry on), one change per worker, then run the gates. Every state command warns while a done worker's workspace is still there, naming both ways out (prune it, or hand it to the next worker); what prune keeps, it names with why.

Record `--task-id <agentId>` once the worker is spawned: its tokens and duration are then read from its transcript on every command.

### 6. Respond

**A running row is not proof of work.** Your chat watch prints `! worker b50 ... has written nothing since 16:30` after twenty minutes without a tool call (the page and `fleets show` mark it too): ask it where it stands (`SendMessage`), or park it with the reason. A refusal reported by a worker (`blocked: ...`) becomes a roadblock at once, with the action the user can take.

**Said once, on the page.** What you answer the user on the page is written there only. The turn that answered ends, in your session, with one line naming where: "Answered #42 on the page." The user reads the page, from any device; the same words in the session are paid twice, written and then read on every later turn. The plugin's Stop hook enforces it: a turn that said on the page and ends with more than two lines or 200 characters goes on once, to end with that line.

Workers report back with results, questions, or blocks. Handle each in the same turn it arrives:

- A **question** you can answer from context gets a reply through `SendMessage` (the worker keeps its context; a new spawn would lose it). One you cannot answer from context goes to the advisor first, when the fleet has one.
- A **block** that needs the user (a credential, a product decision, a destructive step) becomes a decision (see [Decisions](#decisions)), with a roadblock pointing at it when a worker is stopped, and goes into your next message to the user by its title.
- A **report** gets read for what it verified, not just what it claims, and against the standards. Probe one thing the report did not claim (run the route, open the page, read the file it said it left alone): that is where the defects two reports both missed turn up. Unverified claims and rule breaks go back to the same worker with the specific ask (`SendMessage`, then `agent a1 --status running`, which starts its next round in the ledger): its context is worth more than a clean window.
- A message from the user that opens with **`[auto] tstack updated`** is the update timer speaking in their name: re-read the skill files it names from the new copy, follow them from then on, and answer with one line saying what changed for this fleet (or nothing); the user restarts this session when convenient.
- A **chat message** arrives as a line from the chat watch (`#12 user -> a1 (auth-impl): how far along are you?`). Addressed to you: answer it on the page with `fleet chat <dashboard-dir> say --as coordinator --re 12 "<answer>"`. Addressed to a worker: the worker reads it at its next checkpoint; forward it by `SendMessage`, number and text, only when the watch prints `! worker a1 ... has not answered #12 ... for 10 min`. A line with `(quoting <where>: "...")` is about that excerpt of the page: answer about it. A line tagged `[via manager #N]` is the user's message written on the manager's page and delivered by the hub: answer it like any other, in your own chat with `--re`; the hub shows your answer on the manager's page. A line tagged `[side chat #N]` is a side chat, a quick question apart from the main thread: answer it with `--re` (the reply stays in the side chat), briefly, or hand it to a Researcher worker with the quote and the question and let it answer the page as itself; it does not enter your plan unless the answer changes something. When the message changes the plan (scope, a lane, priorities), it is a decision: record it as an event and act on it as you would on the same words typed in the session. A message from the user with `/<skill>` at the start of a word, anywhere in it (`#12 user -> coordinator: /tstack:tdd fix the parser`, `#13 user -> coordinator: the parser again, run /tstack:diagnosing-bugs`), is the user typing that command: invoke the skill with the Skill tool, the message's other words as its arguments and its quote, if any, as context, as if typed in the session, then answer on the page with `--re`. Several run in the order written. Only the name of a skill or command you can run (what the page lists after "/") counts; a path or URL (`src/a/b`, `https://x/y`) never does. A user-only skill (`disable-model-invocation: true`, which the Skill tool refuses) is still the user's to run: read its SKILL.md (a plugin's under that plugin's `skills/`, a personal one under `~/.claude/skills/<name>/`) and follow it with those arguments, rather than telling the user to type it in the terminal.
- An **answer** to a decision arrives as a chat line tagged with it (`#14 user (luiz@github) -> coordinator [d1]: B: Keep both shapes`). Check that it still holds, record it, answer the message, act on it (see [Decisions](#decisions)). An answer or its note with `/<skill>` at the start of a word, anywhere in it (in the note's line, in a grilling's answer after `Q1: `), is the user typing that command: record the answer as given, and run the command with the Skill tool, the other words as its arguments; for an answer, run it before you act on the decision. Several run in the order written. Only the name of a skill or command you can run (what the page lists after "/") counts; a path or URL (`src/a/b`, `https://x/y`) never does. A user-only skill (`disable-model-invocation: true`, which the Skill tool refuses) is still the user's to run: read its SKILL.md (a plugin's under that plugin's `skills/`, a personal one under `~/.claude/skills/<name>/`) and follow it with those arguments, rather than telling the user to type it in the terminal.
- A worker that has **strayed** from its lane (`fleet ws list` names the files) is stopped, and the stray edits are handled before anything else runs on those files.

Every report and every chat message is also read against the open decisions: what you just learned may have answered one, changed one, or made one moot.

Between events, explain to the user what is happening in plain terms: who is on what, what is waiting on whom, what the next milestone is. The dashboard shows it; your message names it.

### 7. Integrate

When a milestone's workers are done: bring each worker's changes into the stack and prune each workspace or hand it to the lane's next worker (Track, above), run the project's checks yourself (types, tests, lint; a quick win), the full gate once per landing (in tstack, `just test`; a worker runs the scoped `just test-changed`, so name that in its completion criterion), each run inside the machine's gate slot (`fleet fleets gate take <fleet> "what" --wait 1800` before, `fleet fleets gate free <token>` after; a worker takes it `--as` its own name; [DASHBOARD.md](DASHBOARD.md)), resolve anything left at the seams between lanes, mark the milestone done, and move the roadmap's current step forward. A milestone counts as done when its checks pass and its reports clear the standards, not when its workers report.

## Decisions

Everything that needs the user is a **decision** in the ledger: a choice between options, an input, a secret, an action only they can take. Pick the kind by who acts next: asking leave to do something yourself (delete, push, spend) is a `decision` with yes and no options, and you act on the answer; an `action` is a step only the user can take, with `--manual` (its commands in a fenced ```` ```nu ```` block, any prose outside it; the CLI refuses more than one line with no fence) and no options (the CLI refuses options on one); a `permission` is a call the harness refused, which the plugin hook opens by itself, and the user allows it once or denies it. The user works through one list on the dashboard, and each decision has a page built for deciding. A question that lives only in a message is lost by the next report: record it, then name it in your message by its title.

Settle what you can first: from this conversation, `CONTEXT.md`, the ADRs, a worker's report, one quick read. What remains is the user's.

A decision carries the bare minimum to decide, written for a person who reads it cold on a phone. Plain words first: on a dense decision Luiz said "reformulate this whole decision, i'm not understanding nothing". What worked was a short story in numbered steps, in the domain's words from `CONTEXT.md`, with no internal ids or mechanics (a sha1, a digest, a stage cache, an alias): say what they mean, or leave them to the body.

- The **question**: the ask alone, one or two plain sentences the user reads in five seconds and answers without reading anything else, the way `/tstack:bro` would say it. One question per decision: two asks are two decisions. A plan, settings, numbers or a trade-off never go in it; they go in the body. The CLI refuses a question over 400 characters, and warns over 300 with no body and on words from its jargon list.
- **Why**: one line on why this needs the user (what only they can judge: money, their files, a client's data, a risk they carry), then what it blocks or the assumption the fleet runs on until they answer. A question the fleet's own tests could settle is not the user's ("what's the worry on this? didn't we test it?"). Prefer the assumption: take the option you would recommend, proceed on it, and let the answer change course. Block (`--blocking`) when proceeding would be destructive, outward-facing, or expensive to undo. The CLI warns over 300 characters.
- For a choice, the **options**: the label is the choice in a few words ("Approve as proposed", "Hold"); the consequence is one sentence (the CLI warns over 160 characters). Each setting the user may change on its own is its own option or its own decision, or a numbered row of the body's Settings table so a note can say "change 3 to ...", never a clause in prose. Then your **recommendation** with its reason in one line: it decided most answers, so it is never left out. Answers often go beyond the options ("None of these: ..." with a new idea, or a condition added after): read the note as part of the answer.
- For a secret or an action, the **route by hand** (`--manual`): short prose, and every command in a fenced block tagged with its language, never in the prose, ```` ```nu ```` on Luiz's machines since he runs nushell, commands that run in one go in one block, a new block only where Luiz acts between steps (reads output, decides, approves in 1Password). Every command runs as written in his shell, now: no bash loop in a nu block, no step that names a script not yet written. The CLI refuses a ```` ```nu ```` block that does not parse in nushell (`nu-check --debug`, when `nu` is on PATH) and warns on bash in one (`&&`, `export X=`, `$(...)`, `2>&1`). The page highlights each block and gives it a copy button.
- The **body** (`--body`, an HTML fragment that says as of when): required when the decision carries a plan, several settings, numbers, a trade-off, a schema, or content to judge; a simple question has none. The worker that holds the data writes it, in its lane. Its sections, each an `<h2>`, in this order, leaving out the ones that do not apply:
  1. **In short** (`<p class="lead">`): two or three lines in bro's register: what happens if they say yes, and what it costs.
  2. **Why this needs you**: the why's first line, when the body is long.
  3. **What you're deciding**: the choice, and what is not part of it.
  4. **Examples**, for a decision about content or classification: real ones (a page image as a data URI, its caption, a comparison group). Luiz twice answered "None of these: show me", and decided at once once he saw them.
  5. **How it works**: a small diagram when the plan has a flow.
  6. **The plan**: numbered steps (`<ol>`). For an architecture decision each step has a **what** line and a **how** line (the module, where it runs, what it stores, who builds it): "we are making architecture decisions so it's important to know how it will be done". Then **Where things run** (a table) and the build order, when they are not plain from the steps.
  7. **What ships**, for a schema or data change: every table and field it adds or changes. His yes covers only what he read (D27 described one table, the change added two, and it was superseded).
  8. **Settings**: a table, `# | setting | proposed | why | change it if`, one numbered row per setting.
  9. **Cost and risk**: each cost labelled measured or estimate, with what it sets off downstream (a re-read redoes names, classification, the index and embeddings), why a costly step is needed, and the cheaper alternative. A big number carries its meaning ("903 pages, about US$3", not a table of counts).
  10. **How to undo**: what reverses each step, and what cannot be reversed.
  11. **What happens after you answer**: the next step, and when the user hears again.

  Show, don't tell (`/tstack:show-me`), where it fits: a small inline SVG for a flow, a before/after table, a table for numbers to compare. Never decoration.
- A **revision** says what changed in one line (`--log "the cap is US$5 now, was US$10"`): the page's history shows it. Never paste the whole plan again in the question or the log; the CLI warns when the question, options or manual change with no `--log`. When the question itself changes, or a recorded decision proves wrong, supersede it (`--supersedes`, after closing the old one) rather than stacking a second ask on it: the old one leaves the open list, and each page links to the other.

A **secret** is asked for as a pointer to it. The decision names the key the code expects (`--secret`, as in `secretspec.toml`), the user answers with a 1Password reference (`op://vault/item/field`) or the item's name, and `--manual` gives the route by hand, in the user's shell syntax. Resolve the reference where the code reads it (`op read`, `secretspec check`) and report whether it resolved; the value stays out of the chat, the ledger, and your messages.

Decisions go stale, and a stale one costs the user a choice that no longer matters. When a report or a message touches an open decision:

- **Answered by other means** (a worker found it, the user said it in the session): close it, saying how. `--decide` when the user said it, `--withdraw` when nobody had to.
- **The facts changed**: revise it with `--log "what changed"`. The page tells the user it changed since they last looked.
- **Changed after it closed**: a closed decision is a record. Open a new one with `--supersedes`.

**Every decision says where it came from.** Open it with `--step <step>` (the step of the plan it belongs to; its milestone follows), or `--milestone` when no one step, and `--agent` for the worker it is for; the same on `grill`. The decision's page names them, the list shows them, and the Plan shows each step's decisions as numbered chips. One opened without them can be tied later, closed or not: `decision A6 --step l19`.

**Waiting on the user is a subscription.** Opening a decision prints its `wait` command: arm it at once as a background command (`run_in_background: true`); it exits when the user answers or the decision closes, and for a grilling you arm it again after each round. Whoever records a decision tells everyone who waits on it: the worker it blocks, and the manager when the manager relayed it or another fleet waits on it.

An answer given on the page is recorded before any other work: every state command warns until it is. Recording it means `decision ID --decide "..." --resolution "..."`; a chat reply alone leaves the decision waiting. Refer to decisions, links and roadblocks by their number (D3, L1, R2) when you write to the user. Check that it still holds (the option may be gone since), then `--decide "<answer>" --resolution "answered on the page (#14)"`, answer the message with `--re 14`, and act. When it no longer holds, answer the message with why and revise the decision. When the answer leads to another question (a query to run again, a figure you still need), revise the decision with the new question, or close it and open the next one: the item is what the page acts on, and a chat reply alone leaves it looking answered.

An answer also changes its neighbours. In the same turn, once it is recorded, go through the fleet's other open items (decisions, grillings, actions, the ones on hold included) and ask of each whether the answer moved its facts, options or assumption. Revise the ones it moved (`--log "what the answer to D3 changed"`), withdraw the ones it made moot, re-present a held one it unblocked, and leave the rest. Say in the answer's reply which items moved, by number, or that none did.

**The classifier never sees the page.** Auto mode's classifier reads the session, not the dashboard, so a yes the user gave on the page does not reach it, and a call they approved can still be refused (`[Production Reads]` after "yes: read-only, aggregates only"). Do not ask again. Give them the one item that lets that call through, and say in one line which you chose and why ("D1 approved it; the spawn was refused as [Production Reads]; P3 lets that exact spawn through once"):

- The **permission** for the exact refused call. The plugin hook opens it by itself for a Bash command or an Agent spawn. Once they allow it, make the same call again, byte for byte (the same command; for a spawn the same `subagent_type`, `description` and `prompt`, no field added): the grant matches that call alone.
- For a read they approved that was refused as a spawn, you may run the narrow read yourself instead, as one Bash command (the query alone, read-only), so its permission grants exactly what they approved. Say so in the same line.

**A decision or action that asks the user to add a permission rule** carries, from its first revision, the exact command in a ```` ```nu ```` block and says plainly whether the rule clears this refusal. Never prose and a file path that leave them to ask where it goes. The rule goes into the session root's settings, run from the session root in their terminal (an agent that writes its own rule is refused):

```nu
let f = ".claude/settings.local.json"; let s = if ($f | path exists) { open $f } else { {} }; $s | upsert permissions.allow (($s.permissions?.allow? | default []) | append r#'Bash(<the exact command>)'# | uniq) | save -f $f
```

What clears what, in auto mode (measured on Claude Code 2.1.287 and 2.1.288): an exact `Bash(<command>)` allow rule in the session root's settings clears a refused Bash call, live, for its subagents too; no allow rule clears a refused Agent spawn (auto mode drops `Agent` allow rules), only its permission does. A refused call of any other tool is an `action`: offer a rule only after checking that tool's rule syntax in the permissions docs (no rule clears a write to a protected path such as `.claude/`); otherwise say plainly that only the session's own terminal can allow it. Never offer a rule that does not clear the refusal.

**When the answer means the fleet acts first** (not ready, needs a fix, the wrong command): `decision A1 --hold "<what the fleet does first>"` at once, then do the work. The hold records the answer and takes the item off the user's list; re-present it by revising it with the new words or command (`--manual`, `--question`, `--option`), which clears the hold and puts it back on their list. Never leave an answered item open without recording it.

**When an action comes back `Failed: <what happened>`**, the step did not work. Read the note (it often holds the error), fix what can be fixed (a better command, a missing step, a different route; `--hold "<the fix>"` while it takes a while), then revise the action with the fix (`--manual`, `--question`, `--log "what changed"`) to re-present it, or `--withdraw "<why>"` when it no longer needs doing. Answer the message with `--re`. Never record it as done: the CLI refuses `--decide` while it stands failed, and the page shows it as failed until you revise or withdraw it.

When the session ends, stop the advisor's row (`park --agent advisor "fleet done"`); `set --status done` names each decision still open and each workspace not pruned: withdraw it with its reason, or name it in your last message as left open on purpose.

The commands and the schema are in [DASHBOARD.md](DASHBOARD.md#decisions).

## Grillings and links

A **grilling** (the `grilling` or `grill-me` skill, or any round of questions to settle a design) runs on the page, never as chat messages: `fleet state <dir> grill <id>` with one `--ask` per question. The `grilling` skill's "On a fleet dashboard" says how rounds, follow-ups, answers, and the end are recorded. A confirmation after the last answer (a recap, the advisor's amendments) is one more question of the grilling (`grill <id> --ask`), answerable on the page, never a chat message asking for "confirm". Once every question is answered, record the grilling at once (`grill <id> --done "what was agreed"`, or `decision <id> --withdraw "why"`): until then it waits on you, not on the user, and `fleet state` says so at every command.

A **link** names a place the user opens: `fleet state <dir> link <id> --url <address> --title "<what it is>" --kind dev|page`. Record every dev server and every page a worker builds for the user (a review, a lab, a report), from the worker's report; `--decision` ties a page to the decision it serves, so the decision's page opens it; `--drop "why"` when it stops. The Links view lists them, up or down, and what the machine serves that no link names.

## With a manager

One session may manage every coordinator on the machine (the `manager` skill). `fleet serve` says so when it registers your fleet, and `fleet fleets manager` asks again: the manager's session, its page, and `standing.md`. With a manager:

- **One address.** The hub serves every page of the machine, yours at `<hub>/f/<fleet>/` (what `fleet serve` prints) and the manager's at `<hub>/f/manager/`, with their chats and decisions; its index lists every fleet. Give the user the hub's address: from it they move between the manager and every fleet with the switcher in the header.
- **Your fleet's name is your session's.** The registry reads it from the session's title (a `/rename` carries over); use that name in everything you write. `fleet fleets name <dashboard-dir> <session>` records it by hand for a session with no title.
- **Say it once.** The user's message to you on the manager's page arrives in your own chat, tagged `[via manager #N]`: answer it there, and the hub copies the answer onto the manager's page. A question from the manager comes with where to answer: the user's message on the manager's page (`fleet chat <manager-dir> say --as <fleet> --re N "..."`), or `SendMessage` when it asked in its own name. Answer there, once. Your own session's reply afterwards is one line at most ("answered #14 on the manager's page"), never the answer again; and a message that only acknowledges is not sent. The manager reads your ledger with `fleet fleets show`, so a now-line kept current answers most questions before they are asked.
- **Read `standing.md`** at intake and when the manager says it changed: what the user decided for every fleet, who owns what, what a landing needs. What bears on a worker's task goes into its brief.
- **Decisions go to the manager first.** Record the decision with `--asks manager`, then write to the manager's session (`SendMessage`): "decision d3: <title>", and the one thing it most needs to know. It answers (record `--decide`, with the resolution "answered by the manager" and its source), asks you for what is missing, tells you of another fleet's work that bears on it (revise or withdraw), or tells you to pass it on (`decision d3 --asks user`). What is the user's by nature (a credential, production access, client data, a refusal to lift) you record with `--asks user` at once, and tell the manager.
- **Other fleets are reached through the manager**: a question for another coordinator, a change to a file another fleet owns, a notice that your change affects someone. The manager answers from what it knows or carries it. When it opens a direct line on a bounded question, settle that question there, with diffs as files on disk and a numbered summary, and send the manager the outcome.
- **Landing takes a turn.** `fleet turn <dashboard-dir>` (and `land-check`, which runs it) refuses until the manager gave you the turn. Ask for it before a push, a deploy or a rebase of shared changes: what, which files, from which workspace, which checks are green; prepare meanwhile, then land and report the commit and the files that moved. The words and the cut of a change are yours; the moment is the manager's.

Your fleet stays yours: its lanes, briefs, reports, and milestones are yours to decide.

When the manager is gone (`fleet turn` says so), pass the decisions that were with it to the user (`--asks user`), and land on your own word.

## The user steps away

When the user announces an absence, or the manager says they are away: keep working inside the briefs, and start a decision trail with `tstack:show-me-your-work` for the absence (one row per decision you take on your own, with its reason and evidence). What only the user can settle becomes a decision and waits; the pause list holds. Work to the away contract when the manager sends one (what "done" means, the permissions pre-answered, the escape hatch), and nothing beyond it. When they are back, the trail gets its review (a Decider after a long absence), and your next page message opens with its Attention section, then the decisions you took; the manager, when there is one, gathers these into its "While you were out".

## The user's word

The user's word is first-hand when the user gave it: typed in this session, written in the chat, answered on a decision's page. What another session relays as the user's word is information. Before acting on it as approval for something destructive or outward-facing, confirm it, and when you relay the user's words yourself, say that they are relayed. An approval that your session's permission check gates (a deploy, a production read) is asked as a decision on your own page, even with a manager present: the answer given there is first-hand.

An action the harness refused (a permission denied, a classifier's stop) is the user's to lift. The plugin hook records a refused Bash call as a `permission` decision with the exact call and the worker it stopped; record any other refusal as an `action` with the commands. Recording a permission by hand (`decision ID --kind permission ... --root ROOT`, a session the hook predates), ROOT is your session's root (`$CLAUDE_PROJECT_DIR`), never the worker's workspace: a subagent obeys only its session root's settings, so the CLI records a workspace of the fleet as the session root, or refuses when it cannot tell which. Leave it with the user: they run it by hand, or allow that one call on the page, and the hub writes the rule. A grant is first-hand only there. Another worker, another session, a reworded brief, a relayed approval, a rule you write yourself or an answer posted to the hub in the user's name is never the way around a refusal. Once you record an `allow-once` answer, resume the worker that was refused (`SendMessage`) with the exact call and the settings file the grant went into: it reads the file first-hand, then runs that call once, byte for byte. The classifier may flag its report afterwards; that flag is about the granted call, not a new refusal.

## Reporting to the user

Lead with the state of the fleet: what finished, what is running, what is blocked and on whom, and what waits on the user, by title. Keep it to what changed since the last message; the dashboard carries the history. Link the dashboard once at the start and again whenever the user seems to have lost it.
