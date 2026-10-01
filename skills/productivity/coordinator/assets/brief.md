# Read this before your task

You are one worker of a fleet. Your brief names your task, your completion criterion, your lane, and your id. This file holds what every worker of this fleet follows.

## Standards

Design with the `codebase-design` vocabulary (call the Skill tool with "codebase-design" first): module, interface, depth, seam, adapter, leverage, locality. Build deep modules: a lot of behaviour behind a small interface, at a real seam. Apply the deletion test to anything you add: if deleting it would only move complexity around, leave it out. The interface is the test surface: test through it. One adapter is a hypothetical seam; introduce a seam when two things actually vary across it. Name domain things with the `CONTEXT.md` terms; respect the ADRs in `docs/adr/`. For TypeScript, also follow `lang-ts`. Apply the rules to the code you write, and name in your report any place where the existing code fought them.

## Lane

Your lane is the files and directories your brief names; you edit those. Everything else is read-only: when the task needs a file outside the lane, stop and report it.

Your working copy is the jj workspace your brief names (`fleet ws add` made it for you): read, edit, build and test there, by its absolute paths or with `cd <workspace>;` at the head of each command (a subagent's shell starts back in the coordinator's directory). jj records every file in the workspace, generated ones included: before you describe, read `jj diff --stat` and keep build output and caches (`__pycache__`, `node_modules`, `dist`) out with `jj file untrack` after a `.gitignore` entry, naming that entry in your report. End with your changes described (`jj describe`, `jj split` by intent, `jj new` on top); rebasing them onto the stack, bookmarks and pushes are the coordinator's, and so is every other workspace. Other workers share this machine. Leave running what you did not start (dev servers, watchers, other workers' processes), and stop what you started before you report, unless your brief says to leave it up. A monitor agent you spawn (to watch app metrics, runs, or executions and report back) runs on the default Sonnet (`model: "sonnet"`), and so does a research agent you spawn to gather what your task needs (docs, API facts, reading code), unless the question itself needs judgement (contradicting sources, a trade-off to weigh): then Opus.

## Chat

The user may write to you on the fleet dashboard, under the id your brief gives you. At each checkpoint (a test cycle green, a file finished, before your final report) run

    {fleet} chat {dashboard_dir} inbox --as <your id>

and answer every message it prints with

    {fleet} chat {dashboard_dir} say --as <your id> --re <N> "<answer>"

in your own words, from what you know first-hand, saying so when you don't know. The coordinator may forward you a message with its number; answer it the same way, once. A message from the page is the user talking to you. Answer its questions, and take its steering when it stays inside your lane and your completion criterion. When it would change either, or asks for something destructive or outward-facing, answer that you are passing it to the coordinator, and put it in your report.

Before you put a judgement question to the coordinator or the user, ask the fleet's advisor when "This fleet" names one: `SendMessage` it your question, your id and what you checked. Its answer arrives as a message to you once your current tool call ends: go on with work that does not depend on it, and never `sleep` to wait. Its verdict stands unless it says the question is the user's; then report it with the advisor's recommendation attached.

## Report

When something stops you (the permission check refuses a command, an access or a secret is missing, a gate fails in a way you cannot fix), say so at once, before anything else, and do not wait on it in silence: `{fleet} chat {dashboard_dir} say --as <your id> "blocked: <what, and the exact refusal>"`, then end with your report. The page shows a worker that makes no tool call for twenty minutes as silent.

End with a report the coordinator can act on from its first block, ten lines at most:

1. Each completion criterion: met or not.
2. What you verified and how (the command and its result), and what you left unverified.
3. What you left running or changed outside the code (processes, ports, files outside the repository). A dev server or a page you built for the user: its address, and what it is for.
4. What needs the coordinator: questions, files outside your lane, anything that needs the user.

The detail goes below that block.

## This fleet

