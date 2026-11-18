---
name: heads-up
description: "A session's own status report for Luiz: done, doing, waiting on him, and loose ends forgotten in the pile; when nothing is left, offer cleanup, then suspend. Use for /heads-up."
disable-model-invocation: true
---

# Heads-up

Luiz is checking on this session from outside. Tell him, from the record, whether it is working, waiting on him, or done, and find the loose ends the work dropped along the way. Unlike `/ketchup` (what changed since his last message), a heads-up covers the whole session.

## 1. Sweep (read-only)

Change nothing in this step but the asks and answers unblock sends. Check each source and note what it shows:

- **His asks.** Every request Luiz made in this session, each one: done, in progress, dropped, or replaced by a later ask. A request answered only with a plan or an offer is not done.
- **Promises and offers.** Every "I'll …", "next …" and offer this session made that has no answer or no follow-through.
- **Agents and tasks.** Subagents and background tasks: still running, finished with a report not yet acted on, or stopped.
- **History.** `jj st`, `jj log -r 'trunk()..@'` in each workspace this session used and `jj workspace list`: undescribed or unpushed changes, conflicts, and workspaces this session added.
- **Shipping.** For each change this session made: landed, pushed, deployed or reinstalled where its repo does that. A gate this session holds (`fleet gate`).
- **Blockers.** Read and follow [unblock](../unblock/SKILL.md) (a user-invoked skill, so read the file): it finds what this session waits on and what waits on it, and asks each owning agent for the action that clears it. Carry its result into the report.
- **Durable state.** Knowledge that lives only in this chat or the scratchpad and belongs in memo, a dossier, a plan or the repo.

A **loose end** is anything from this sweep that nobody will pick up once the session ends.

## 2. Report

Open with one line saying which it is: **Working** (on what, and what finishes it), **Waiting on you** (on what), or **Done** (nothing left).

Then, in plain words, one short bullet each:

- **Done**: what came of each ask, in his words, with where it lives (pushed commit, artifact, file).
- **Doing**: what runs now and what ends it.
- **Waiting on you**: each call that is his, with your pick and the reason, so he can answer from this reply.
- **Blocked**: each blocker `/unblock` found, its owner, and what was asked or delivered.
- **Loose ends**: each one, with what you would do about it. Say "none found" when the sweep found none.

Leave out any section with nothing in it, except loose ends.

## 3. When done: clean up, then suspend

When the report is **Done**, or the only loose ends are ones you can close yourself, list the cleanup in one short bullet each: workspaces to forget, empty changes to abandon, gates to free, tasks to stop, notes to save. End the reply with **Clean up and suspend?**

On his yes: do the cleanup, stop any background tasks (TaskStop), then run `fleet suspend me --why "<what was done, and where the record is>"`, as tuca-mode's suspend rule says. Without `fleet` on PATH, say the work is done and cleaned, and stop.

When the report is **Working** or **Waiting on you**, end on that instead, and keep working on what you can.
