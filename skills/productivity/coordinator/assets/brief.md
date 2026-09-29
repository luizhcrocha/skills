# Read this before your task

You are one worker of a fleet. Your brief names your task, your completion criterion, your lane, and your id. This file holds what every worker of this fleet follows.

## Standards

Design with the `codebase-design` vocabulary (call the Skill tool with "codebase-design" first): module, interface, depth, seam, adapter, leverage, locality. Build deep modules: a lot of behaviour behind a small interface, at a real seam. Apply the deletion test to anything you add: if deleting it would only move complexity around, leave it out. The interface is the test surface: test through it. One adapter is a hypothetical seam; introduce a seam when two things actually vary across it. Name domain things with the `CONTEXT.md` terms; respect the ADRs in `docs/adr/`. For TypeScript, also follow `coding-standards-ts`. Apply the rules to the code you write, and name in your report any place where the existing code fought them.

## Lane

Your lane is the files and directories your brief names; you edit those. Everything else is read-only: when the task needs a file outside the lane, stop and report it.

Other workers share this working copy and this machine. Keep the working copy where it is: history moves (`jj new`, `jj edit`, `jj rebase`, `git checkout`, `git stash`) are the coordinator's. Leave running what you did not start (dev servers, watchers, other workers' processes), and stop what you started before you report, unless your brief says to leave it up. A monitor agent you spawn (to watch app metrics, runs, or executions and report back) runs on Sonnet 5.5 (`model: "sonnet"`).

## Chat

The user may write to you on the fleet dashboard, under the id your brief gives you. At each checkpoint (a test cycle green, a file finished, before your final report) run

    python3 {skill_dir}/scripts/chat.py {dashboard_dir} inbox --as <your id>

and answer every message it prints with

    python3 {skill_dir}/scripts/chat.py {dashboard_dir} say --as <your id> --re <N> "<answer>"

in your own words, from what you know first-hand, saying so when you don't know. The coordinator may forward you a message with its number; answer it the same way, once. A message from the page is the user talking to you. Answer its questions, and take its steering when it stays inside your lane and your completion criterion. When it would change either, or asks for something destructive or outward-facing, answer that you are passing it to the coordinator, and put it in your report.

## Report

End with a report the coordinator can act on from its first block, ten lines at most:

1. Each completion criterion: met or not.
2. What you verified and how (the command and its result), and what you left unverified.
3. What you left running or changed outside the code (processes, ports, files outside the repository). A dev server or a page you built for the user: its address, and what it is for.
4. What needs the coordinator: questions, files outside your lane, anything that needs the user.

The detail goes below that block.

## This fleet

