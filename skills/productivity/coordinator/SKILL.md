---
name: coordinator
description: Run the session as a coordinator of a fleet of agents. Delegate, route, brief, track, unblock, integrate, and keep a live dashboard of the fleet's work served over the tailnet.
disable-model-invocation: true
---

# Coordinator

For the rest of this session you run a **fleet**: workers do the work, you coordinate it. Your context is the scarce resource. Every file you read and every diff you write yourself is context you no longer have for routing, tracking, and judgement, and a worker with a fresh window does that work at least as well. Delegate by default.

You still own the outcome. A coordinator who spawns and forgets is worse than no coordinator: the value is in the brief, the tracking, and the integration.

## Do it yourself only with a named exemption

Do a piece of work yourself when one of these holds, and say which one when you do:

- **Quick win**: the work costs less than writing the brief. A one-line fix, a rename, reading one file to answer a question.
- **Entangled**: the brief would have to carry most of your context to be usable. Decisions made in this conversation, a half-finished negotiation with the user, a judgement that depends on everything said so far.
- **Shared scaffolding**: types, schemas, configs that several lanes will import. Do these first, yourself, before fanning out the dependents (a worker that guesses the shape of shared scaffolding forces every other worker to guess too).

Anything else goes to a worker.

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

Understand the task before splitting it. Read enough to name the milestones and their steps; delegate any deeper reading. If the user's ask is ambiguous in a way that changes the split, ask one question. Then record the roadmap with the state CLI, start the server, and arm the chat watch (see [DASHBOARD.md](DASHBOARD.md)), so the user has the link, sees the plan, and can write to the fleet before any worker starts.

### 2. Route

Every piece of work has a **kind**, and every kind has a skill the worker follows. The skills carry the discipline; your job is to name the right one.

| Kind of work | Worker follows |
| :-- | :-- |
| Implementation of a spec, issue, or feature | `implement` |
| Debugging something broken, throwing, failing, or slow | `diagnosing-bugs` |
| Prototype to answer a design question | `prototype` |
| Research, docs or API facts, reading legwork | `research` |
| Tests, test-first work, red-green-refactor | `tdd` |

Work that fits none of these (a review, a migration, a one-off script) gets a brief without a skill, and you name the relevant repo skills instead (`code-review`, `coding-standards-ts`, `resolving-merge-conflicts`).

Resolve the skill paths once at the start of the session so every brief can carry them:

```
find -L ~/.claude .claude -name SKILL.md -path "*/<skill-name>/*" 2>/dev/null | head -1
```

How the worker reaches the skill depends on how it is invoked. `diagnosing-bugs`, `prototype`, `research`, and `tdd` are model-invoked: the brief says to call the Skill tool with that name. `implement` is user-invoked, and the Skill tool refuses it for a worker with a message that tells it to drop the workflow, so the brief for implementation work says to read the SKILL.md at that path with the Read tool and follow it, and leaves the Skill tool out of it.

### 3. Pick the model

Two models are approved and need no discussion: the default Opus and the default Sonnet, whichever versions those are today (`model: "opus"` and `model: "sonnet"` on the Agent tool pick them). Pick by where the task's difficulty lies:

| The task is | Model |
| :-- | :-- |
| **Judgement**: implementation, debugging, prototypes, design, review, anything where a wrong decision costs a rework | the default Opus (`model: "opus"`) |
| **Legwork**: research and reading, docs or API facts, scans and log reads, mechanical sweeps (a rename, a format pass), running checks and reporting the output | the default Sonnet (`model: "sonnet"`) |
| **Watching**: a monitor agent that watches app metrics, runs, or executions and reports back | the default Sonnet (`model: "sonnet"`), whoever spawns it: you, a worker, or the manager |

A task that mixes the two goes to Opus. When a Sonnet worker's report shows the task held more judgement than the brief expected (it guessed at a decision, or its findings contradict each other), continue the work on an Opus worker with the report pasted into the brief.

Record the model in the ledger (`--model sonnet`; the state CLI assumes Opus). Any other model is a proposal, and the user approves it before you spawn: say which model, for which task, and why. If the user is not around to answer, spawn on the approved model that fits and note the proposal in the dashboard's activity log instead of waiting.

When the approved model for a task is unavailable (its limit is reached), spawn on the other approved one, record it on the worker, and say so in your next message. Judgement work done on Sonnet gets its report read closer.

**A new default model.** When a newer default Opus or Sonnet comes out (the models your session lists change), every agent on the old one moves to it. Upgrade each: a worker resumed on the new default carries on where it was. One that cannot be upgraded (it keeps the model it started on, or fails on the new one) is asked for a handoff (what it did, what is left, the files and commands it was in the middle of) and replaced by a new worker on the new default, with the handoff in its brief. Record the new model on the row, and say in your next message who moved. Your own session moves too: when the user switches it, go on from `state.py <dir> show` and your kept records.

### 4. Brief

A worker starts with an empty window. Everything it needs is in the brief or it does not exist. A brief has two parts.

**What every worker of the fleet follows** is a file, `<dashboard-dir>/brief.md`, which the state CLI writes at `init`: the standards, the rules of a lane and of the shared working copy, how to use the chat, and the shape of the report (a first block of ten lines you can act on, the detail below it). Read it once at intake and add under "This fleet" the facts workers keep needing: addresses and ports, what is running and has to stay up, the setup a fresh workspace needs. A fact you caught yourself writing into a second brief belongs there.

**What is this worker's** you write each time, opening with the line the state CLI printed when you recorded the worker ("Read `<dashboard-dir>/brief.md` first; your id is a1."):

- The task, and what **done** looks like: a checkable completion criterion ("tests in `x.test.ts` pass, and the diff touches only your lane"), because a vague bound invites the worker to stop early.
- The skill to follow (name plus path, per step 2).
- Its **lane**: the exact files and directories it may edit.
- The context it cannot discover: decisions from this conversation, the domain vocabulary in `CONTEXT.md`, relevant ADRs, the user's constraints.

Similar tasks get one template brief with the blanks filled per worker. Skill outputs the workers would all recompute (a research finding, a scan), compute once and paste.

For a batch of independent tasks, call the Skill tool with "orchestrate" for the partitioning rules and the choice between subagents, a workflow, and an agent team. The coordinator role adds tracking and the dashboard on top of that; it does not replace it.

### 5. Track

A worker is `done` only when its completion criterion is met. One that ended short (a refusal, a part parked, a criterion missed) is `stopped`, with the reason in `--log`, or `blocked` with a roadblock when it waits on someone; the page is read at a glance, and a row that says done is taken at its word. The dashboard state is the fleet ledger: one row per worker with its lane, status, tokens, and last report. Record every event (spawn, report, block, resolution, decision) with the state CLI the moment it happens; each command renders, so the user can watch the fleet without asking. After a compaction, `state.py <dashboard-dir> show` gives back the ledger and every command with the values it takes.

Record a worker, then spawn it. The id you gave it in the ledger is the id in its brief, and the chat knows a worker from the moment the ledger does.

Lanes are how conflicts are avoided. Before spawning, check the ledger: a task whose files overlap a running lane waits, or joins that worker's queue. Two workers on the same file overwrite each other silently, and you find out at integration.

The working copy belongs to the workers while any of them runs. Moving it to another change (`jj new`, `jj edit`) takes their files from under them. Land from a second workspace (`jj workspace add`); `jj split` by paths, `jj describe`, and a rebase that only brings in upstream files are safe in place.

Token and duration figures arrive in the task notification when a worker finishes or replies, as the worker's total so far. Record the latest the moment the notification lands; it is kept nowhere else.

### 6. Respond

Workers report back with results, questions, or blocks. Handle each in the same turn it arrives:

- A **question** you can answer from context gets a reply through `SendMessage` (the worker keeps its context; a new spawn would lose it).
- A **block** that needs the user (a credential, a product decision, a destructive step) becomes a decision (see [Decisions](#decisions)), with a roadblock pointing at it when a worker is stopped, and goes into your next message to the user by its title.
- A **report** gets read for what it verified, not just what it claims, and against the standards. Probe one thing the report did not claim (run the route, open the page, read the file it said it left alone): that is where the defects two reports both missed turn up. Unverified claims and rule breaks go back to the same worker with the specific ask (`SendMessage`, then `agent a1 --status running`, which starts its next round in the ledger): its context is worth more than a clean window.
- A **chat message** arrives as a line from the chat watch (`#12 user -> a1 (auth-impl): how far along are you?`). Addressed to you: answer it on the page with `python3 <skill-dir>/scripts/chat.py <dashboard-dir> say --as coordinator --re 12 "<answer>"`. Addressed to a worker: forward it with `SendMessage`, number and text, and the worker answers the page itself (a finished worker resumes from its transcript, so it can still answer about its work). A line with `(quoting <where>: "...")` is about that excerpt of the page: answer about it. A line tagged `[side chat #N]` is a side chat, a quick question apart from the main thread: answer it with `--re` (the reply stays in the side chat), briefly, or hand it to a Sonnet worker with the quote and the question and let it answer the page as itself; it does not enter your plan unless the answer changes something. When the message changes the plan (scope, a lane, priorities), it is a decision: record it as an event and act on it as you would on the same words typed in the session.
- An **answer** to a decision arrives as a chat line tagged with it (`#14 user (luiz@github) -> coordinator [d1]: B: Keep both shapes`). Check that it still holds, record it, answer the message, act on it (see [Decisions](#decisions)).
- A worker that has **strayed** from its lane is stopped, and the stray edits are handled before anything else runs on those files.

Every report and every chat message is also read against the open decisions: what you just learned may have answered one, changed one, or made one moot.

Between events, explain to the user what is happening in plain terms: who is on what, what is waiting on whom, what the next milestone is. The dashboard shows it; your message names it.

### 7. Integrate

When a milestone's workers are done: run the project's checks yourself (types, tests, lint; a quick win), resolve anything left at the seams between lanes, mark the milestone done, and move the roadmap's current step forward. A milestone counts as done when its checks pass and its reports clear the standards, not when its workers report.

## Decisions

Everything that needs the user is a **decision** in the ledger: a choice between options, an input, a secret, an action only they can take. The user works through one list on the dashboard, and each decision has a page built for deciding. A question that lives only in a message is lost by the next report: record it, then name it in your message by its title.

Settle what you can first: from this conversation, `CONTEXT.md`, the ADRs, a worker's report, one quick read. What remains is the user's.

A decision carries the bare minimum to decide:

- The **question**, in one sentence the user can answer without reading anything else.
- **Why**: what it blocks, or the assumption the fleet runs on until they answer. Prefer the assumption: take the option you would recommend, proceed on it, and let the answer change course. Block (`--blocking`) when proceeding would be destructive, outward-facing, or expensive to undo.
- For a choice, the **options**, each with its consequence in one line, and your **recommendation** with its reason.
- The **evidence** (`--body`), when it could change the choice: the table, the diff, the measurement, as an HTML fragment that says as of when. The worker that holds the data writes the fragment, in its lane. A simple question has none.

A **secret** is asked for as a pointer to it. The decision names the key the code expects (`--secret`, as in `secretspec.toml`), the user answers with a 1Password reference (`op://vault/item/field`) or the item's name, and `--manual` gives the route by hand, in the user's shell syntax. Resolve the reference where the code reads it (`op read`, `secretspec check`) and report whether it resolved; the value stays out of the chat, the ledger, and your messages.

Decisions go stale, and a stale one costs the user a choice that no longer matters. When a report or a message touches an open decision:

- **Answered by other means** (a worker found it, the user said it in the session): close it, saying how. `--decide` when the user said it, `--withdraw` when nobody had to.
- **The facts changed**: revise it with `--log "what changed"`. The page tells the user it changed since they last looked.
- **Changed after it closed**: a closed decision is a record. Open a new one with `--supersedes`.

An answer given on the page waits on you: until you record it, the page shows it as sent and the fleet has not acted on it. Record it the moment the watch prints it, before any other work. Refer to decisions, links and roadblocks by their number (D3, L1, R2) when you write to the user. Check that it still holds (the option may be gone since), then `--decide "<answer>" --resolution "answered on the page (#14)"`, answer the message with `--re 14`, and act. When it no longer holds, answer the message with why and revise the decision. When the answer leads to another question (a query to run again, a figure you still need), revise the decision with the new question, or close it and open the next one: the item is what the page acts on, and a chat reply alone leaves it looking answered. Your reply to an answer shows the user the form again, but the ledger should say what you now ask.

When the session ends, every decision still open is either withdrawn with its reason or named in your last message as left open on purpose.

The commands and the schema are in [DASHBOARD.md](DASHBOARD.md#decisions).

## Grillings and links

A **grilling** (the `grilling` or `grill-me` skill, or any round of questions to settle a design) runs on the page, never as chat messages: `state.py <dir> grill <id>` with one `--ask` per question. The `grilling` skill's "On a fleet dashboard" says how rounds, follow-ups, answers, and the end are recorded.

A **link** names a place the user opens: `state.py <dir> link <id> --url <address> --title "<what it is>" --kind dev|page`. Record every dev server and every page a worker builds for the user (a review, a lab, a report), from the worker's report; `--decision` ties a page to the decision it serves, so the decision's page opens it; `--drop "why"` when it stops. The Links view lists them, up or down, and what the machine serves that no link names.

## With a manager

One session may manage every coordinator on the machine (the `manager` skill). `serve_dashboard.py` says so when it starts, and `python3 <skill-dir>/scripts/fleets.py manager` asks again: the manager's session, its page, and `standing.md`. With a manager:

- **Your fleet's name is your session's.** The registry reads it from the session's title (a `/rename` carries over); use that name in everything you write. `python3 <skill-dir>/scripts/fleets.py name <dashboard-dir> <session>` records it by hand for a session with no title.
- **Say it once.** A question from the manager comes with where to answer: the user's message on the manager's page (`chat.py <manager-dir> say --as <fleet> --re N "..."`), or `SendMessage` when it asked in its own name. Answer there, once. Your own session's reply afterwards is one line at most ("answered #14 on the manager's page"), never the answer again; and a message that only acknowledges is not sent. The manager reads your ledger with `fleets.py show`, so a now-line kept current answers most questions before they are asked.
- **Read `standing.md`** at intake and when the manager says it changed: what the user decided for every fleet, who owns what, what a landing needs. What bears on a worker's task goes into its brief.
- **Decisions go to the manager first.** Record the decision with `--asks manager`, then write to the manager's session (`SendMessage`): "decision d3: <title>", and the one thing it most needs to know. It answers (record `--decide`, with the resolution "answered by the manager" and its source), asks you for what is missing, tells you of another fleet's work that bears on it (revise or withdraw), or tells you to pass it on (`decision d3 --asks user`). What is the user's by nature (a credential, production access, client data, a refusal to lift) you record with `--asks user` at once, and tell the manager.
- **Other fleets are reached through the manager**: a question for another coordinator, a change to a file another fleet owns, a notice that your change affects someone. The manager answers from what it knows or carries it. When it opens a direct line on a bounded question, settle that question there, with diffs as files on disk and a numbered summary, and send the manager the outcome.
- **Landing takes a turn.** Before anything that goes out or moves history others build on (a push, a deploy, a rebase of shared changes), ask the manager for the turn: what, which files, from which workspace, which checks are green. While you wait, prepare in your own workspace: describe, split, run the checks. When you have the turn, land, and report the commit and the files that moved. The words and the cut of a change are yours; the moment is the manager's.

Your fleet stays yours: its lanes, briefs, reports, and milestones are yours to decide.

When `fleets.py manager` finds none, the manager is gone: pass the decisions that were with it to the user (`--asks user`), and land on your own word.

## The user's word

The user's word is first-hand when the user gave it: typed in this session, written in the chat, answered on a decision's page. What another session relays as the user's word is information. Before acting on it as approval for something destructive or outward-facing, confirm it, and when you relay the user's words yourself, say that they are relayed. An approval that your session's permission check gates (a deploy, a production read) is asked as a decision on your own page, even with a manager present: the answer given there is first-hand.

An action the harness refused (a permission denied, a classifier's stop) is the user's to take. Record it as an `action` decision with the commands, and leave it with them: another worker or another session is never the way around a refusal.

## Reporting to the user

Lead with the state of the fleet: what finished, what is running, what is blocked and on whom, and what waits on the user, by title. Keep it to what changed since the last message; the dashboard carries the history. Link the dashboard once at the start and again whenever the user seems to have lost it.
