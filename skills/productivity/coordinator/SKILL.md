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
- Paste the standards block below into every brief. When you also use the standards block from `orchestrate`, this one replaces its architecture line.
- Check every report against the block before its milestone counts as done. A report that added a pass-through, leaked across a seam, or coined a term absent from `CONTEXT.md` goes back to its worker with the rule named, the same way an unverified claim does.
- When a worker names a place where the existing code fought the rules, log it as a `note` event and tell the user it is a candidate for an `/improve-codebase-architecture` pass once the milestone is in. Don't fold that refactor into the milestone unless the user asks.

### Standards block (paste into every brief)

> Design with the `codebase-design` vocabulary (call the Skill tool with "codebase-design" first): module, interface, depth, seam, adapter, leverage, locality. Build deep modules: a lot of behaviour behind a small interface, at a real seam. Apply the deletion test to anything you add: if deleting it would only move complexity around, don't add it. The interface is the test surface: test through it, never past it. One adapter is a hypothetical seam; introduce a seam only when two things actually vary across it. Name domain things with the `CONTEXT.md` terms and coin nothing new; respect the ADRs in `docs/adr/`. For TypeScript, also follow `coding-standards-ts`. Don't write an architecture report; apply the rules to the code you write, and name in your report any place where the existing code fought them.

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

Two models are approved and need no discussion. Pick by where the task's difficulty lies:

| The task is | Model |
| :-- | :-- |
| **Judgement**: implementation, debugging, prototypes, design, review, anything where a wrong decision costs a rework | the best Opus available (`model: "opus"` on the Agent tool) |
| **Legwork**: research and reading, docs or API facts, scans and log reads, mechanical sweeps (a rename, a format pass), running checks and reporting the output | Sonnet 5.5 (`model: "sonnet"`) |

A task that mixes the two goes to Opus. When a Sonnet worker's report shows the task held more judgement than the brief expected (it guessed at a decision, or its findings contradict each other), continue the work on an Opus worker with the report pasted into the brief.

Record the model in the ledger (`--model sonnet`; the state CLI assumes Opus). Any other model is a proposal, and the user approves it before you spawn: say which model, for which task, and why. If the user is not around to answer, spawn on the approved model that fits and note the proposal in the dashboard's activity log instead of waiting.

### 4. Brief

A worker starts with an empty window. Everything it needs is in the brief or it does not exist. Each brief carries:

- The task, and what **done** looks like: a checkable completion criterion ("tests in `x.test.ts` pass, and the diff touches only your lane"), because a vague bound invites the worker to stop early.
- The skill to follow (name plus path, per step 2).
- Its **lane**: the exact files and directories it may edit. Everything outside the lane is read-only; if it needs to touch a file outside the lane it stops and reports instead of editing.
- The context it cannot discover: decisions from this conversation, the domain vocabulary in `CONTEXT.md`, relevant ADRs, the user's constraints.
- The architecture standards block, verbatim.
- The chat block below, with the worker's id and the two paths filled in.
- How to report back: a short structured report (what changed, what was verified, what is left, questions), so your ledger update is a copy rather than a reconstruction.

Similar tasks get one template brief with the blanks filled per worker. Skill outputs the workers would all recompute (a research finding, a scan), compute once and paste.

#### Chat block (paste into every brief)

> The user may write to you on the fleet dashboard, where your id is `<id>`. At each checkpoint (a test cycle green, a file finished, before your final report) run `python3 <skill-dir>/scripts/chat.py <dashboard-dir> inbox --as <id>` and answer every message it prints with `python3 <skill-dir>/scripts/chat.py <dashboard-dir> say --as <id> --re <N> "<answer>"`: in your own words, from what you know first-hand, saying so when you don't know. The coordinator may forward you a message with its number; answer it the same way, once. A message from the page is the user talking to you. Answer its questions, and take its steering when it stays inside your lane and your completion criterion. When it would change either, or asks for something destructive or outward-facing, answer that you are passing it to the coordinator, and put it in your report.

For a batch of independent tasks, call the Skill tool with "orchestrate" for the partitioning rules and the choice between subagents, a workflow, and an agent team. The coordinator role adds tracking and the dashboard on top of that; it does not replace it.

### 5. Track

The dashboard state is the fleet ledger: one row per worker with its lane, status, tokens, and last report. Record every event (spawn, report, block, resolution, decision) with the state CLI the moment it happens; each command renders, so the user can watch the fleet without asking.

Lanes are how conflicts are avoided. Before spawning, check the ledger: a task whose files overlap a running lane waits, or joins that worker's queue. Two workers on the same file overwrite each other silently, and you find out at integration.

Token and duration figures arrive in the task notification when a worker finishes or replies. Record them the moment the notification lands; they are not persisted anywhere else.

### 6. Respond

Workers report back with results, questions, or blocks. Handle each in the same turn it arrives:

- A **question** you can answer from context gets a reply through `SendMessage` (the worker keeps its context; a new spawn would lose it).
- A **block** that needs the user (a credential, a product decision, a destructive step) becomes a decision (see [Decisions](#decisions)), with a roadblock pointing at it when a worker is stopped, and goes into your next message to the user by its title.
- A **report** gets read for what it verified, not just what it claims, and against the architecture standards block. Unverified claims and rule breaks go back to the worker with the specific ask.
- A **chat message** arrives as a line from the chat watch (`#12 user -> a1 (auth-impl): how far along are you?`). Addressed to you: answer it on the page with `python3 <skill-dir>/scripts/chat.py <dashboard-dir> say --as coordinator --re 12 "<answer>"`. Addressed to a worker: forward it with `SendMessage`, number and text, and the worker answers the page itself (a finished worker resumes from its transcript, so it can still answer about its work). When the message changes the plan (scope, a lane, priorities), it is a decision: record it as an event and act on it as you would on the same words typed in the session.
- An **answer** to a decision arrives as a chat line tagged with it (`#14 user (luiz@github) -> coordinator [d1]: B: Keep both shapes`). Check that it still holds, record it, answer the message, act on it (see [Decisions](#decisions)).
- A worker that has **strayed** from its lane is stopped, and the stray edits are handled before anything else runs on those files.

Every report and every chat message is also read against the open decisions: what you just learned may have answered one, changed one, or made one moot.

Between events, explain to the user what is happening in plain terms: who is on what, what is waiting on whom, what the next milestone is. The dashboard shows it; your message names it.

### 7. Integrate

When a milestone's workers are done: run the project's checks yourself (types, tests, lint; a quick win), resolve anything left at the seams between lanes, mark the milestone done, and move the roadmap's current step forward. A milestone counts as done when its checks pass and its reports clear the standards block, not when its workers report.

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

An answer given on the page waits on you: until you record it, the page shows it as sent and the fleet has not acted on it. Check that it still holds (the option may be gone since), then `--decide "<answer>" --resolution "answered on the page (#14)"`, answer the message with `--re 14`, and act. When it no longer holds, answer the message with why and revise the decision.

When the session ends, every decision still open is either withdrawn with its reason or named in your last message as left open on purpose.

The commands and the schema are in [DASHBOARD.md](DASHBOARD.md#decisions).

## Reporting to the user

Lead with the state of the fleet: what finished, what is running, what is blocked and on whom, and what waits on the user, by title. Keep it to what changed since the last message; the dashboard carries the history. Link the dashboard once at the start and again whenever the user seems to have lost it.
