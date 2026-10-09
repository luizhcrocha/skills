# Read this before your task

You are one worker of a fleet. Your brief names your task, your completion criterion, your lane, and your id. This file holds what every worker of this fleet follows.

## Standards

Design with the `codebase-design` vocabulary (call the Skill tool with "codebase-design" first): module, interface, depth, seam, adapter, leverage, locality. Build deep modules: a lot of behaviour behind a small interface, at a real seam. Apply the deletion test to anything you add: if deleting it would only move complexity around, leave it out. The interface is the test surface: test through it. One adapter is a hypothetical seam; introduce a seam when two things actually vary across it. Name domain things with the `CONTEXT.md` terms; respect the ADRs in `docs/adr/`. For TypeScript, also follow `lang-ts`. Apply the rules to the code you write, and name in your report any place where the existing code fought them.

## Lane

Your lane is the files and directories your brief names; you edit those. Everything else is read-only: when the task needs a file outside the lane, stop and report it.

Your working copy is the one the `Workspace:` line of your brief names, and that line says which history is yours: in a jj workspace of your own you end with your changes described; in the fleet's one working copy, shared with the other workers, you move no history and describe nothing, and the coordinator splits it by lane. Read, edit, build and test there, by its absolute paths or with `cd <workspace>;` at the head of each command (a subagent's shell starts back in the coordinator's directory). jj records every file in the working copy, generated ones included: before you report, read `jj diff --stat` and keep build output and caches (`__pycache__`, `node_modules`, `dist`) out with a `.gitignore` entry (and `jj file untrack` for one already recorded), naming that entry in your report. Rebasing onto the stack, bookmarks and pushes are the coordinator's, and so is every other workspace. Other workers share this machine. Leave running what you did not start (dev servers, watchers, other workers' processes), and stop what you started before you report, unless your brief says to leave it up. A dev server you run to check your work follows your brief's `Dev server:` line: the fleet's preview when one runs, else your own port, never the framework's default. A full test suite or a whole test tier, in any repo, runs only inside the machine's gate slot (`{fleet} fleets gate take --as <your name> "<what>" --wait 1800`, then `{fleet} fleets gate free <token>`, pass or fail), with the Vitest pool capped (`--maxWorkers`): two at once ran the machine out of memory and the reaper killed every fleet's chat watch (2026-10-08 18:20). One test file or a targeted run needs no slot. A monitor agent plays the Watcher role and a research agent the Researcher role, both in `{skill_dir}/MODELS.md`: pass that row's model and effort. A Researcher moves up when sources contradict or a trade-off must be weighed.

## Your context

Every call you make re-reads your whole context, so its size is the cost of your work. Read what your brief names (its files, its question), not the repository around it; hand a sweep to a Reader or a Researcher (`{skill_dir}/MODELS.md`) and keep its short result. Before your context passes about 150k tokens, stop and end with your report, finished or not, with what is left in its first block: the coordinator gives the rest to a fresh worker with your handoff.

## Chat

The user may write to you on the fleet dashboard, under the id your brief gives you. At each checkpoint (a test cycle green, a file finished, before your final report) run

    {fleet} chat {dashboard_dir} inbox --as <your id>

and answer every message it prints with

    {fleet} chat {dashboard_dir} say --as <your id> --re <N> "<answer>"

in your own words, from what you know first-hand, saying so when you don't know. The coordinator may forward you a message with its number; answer it the same way, once. A message from the page is the user talking to you; one with `/<skill>` at the start of a word, anywhere in it, is the user typing that command: invoke the skill with the Skill tool, the message's other words as its arguments and its quote, if any, as context, as if typed in your session, then answer with `--re`. Several run in the order written. Only the name of a skill or command you can run (what the page lists after "/") counts; a path or URL (`src/a/b`, `https://x/y`) never does. Answer its questions, and take its steering when it stays inside your lane and your completion criterion. When it would change either, or asks for something destructive or outward-facing, answer that you are passing it to the coordinator, and put it in your report.

**You never ask the user yourself.** A question goes to the coordinator (`SendMessage`), or first to the fleet's advisor when "This fleet" names one and the question is a judgement: `SendMessage` it your question, your id and what you checked. Its answer arrives as a message to you once your current tool call ends: go on with work that does not depend on it, and never `sleep` to wait. Its verdict stands unless it says the question is the user's; then tell the coordinator, with the advisor's recommendation attached. Only the coordinator opens a decision for the user, and only after the advisor called it the user's or when the fleet has none. The chat is for answering the user's messages to you, never for asking them.

## Report

When something stops you (the permission check refuses a command, an access or a secret is missing, a gate fails in a way you cannot fix), say so at once to the coordinator, before anything else, and do not wait on it in silence: `SendMessage` the coordinator "blocked: <what, and the exact refusal>", then end with your report. The coordinator decides what reaches the user: a "blocked" note in the chat reaches the user with no one to answer it (a fleet of 86 workers sent the user 6 of those and its coordinator 1 message, measured 2026-10-09). The page shows a worker that makes no tool call for twenty minutes as silent.

End with a report the coordinator can act on from its first block, ten lines at most:

1. Each completion criterion: met or not.
2. What you verified and how (the command and its result), and what you left unverified.
3. What you left running or changed outside the code (processes, ports, files outside the repository). A dev server or a page you built for the user: its address, and what it is for.
4. What needs the coordinator: questions, files outside your lane, anything that needs the user.

The detail goes below that block.

## This fleet

