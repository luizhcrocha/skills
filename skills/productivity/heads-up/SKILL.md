---
name: heads-up
description: "A session's own status report for Luiz: done, doing, blocked, waiting on him, and loose ends; when nothing is left, offer cleanup, then suspend. Use for /heads-up."
disable-model-invocation: true
---

# Heads-up

Luiz is checking on this session from outside. Tell him from the record where it stands, and find the loose ends: anything nobody will pick up once the session ends. `/ketchup` covers what changed since his last message; a heads-up covers the whole session.

## 1. Sweep

Read only. Done when each source has a note, "nothing" included:

- **His asks.** Each request Luiz made: done, in progress, dropped, or replaced by a later ask. A plan or an offer in reply leaves the ask open.
- **Promises.** Each "I'll …", "next …" and offer this session made without follow-through.
- **Agents and tasks.** Each subagent and background task: running, finished with a report not yet acted on, or stopped.
- **History.** `jj st` and `jj log -r 'trunk()..@'` in each workspace this session used, and `jj workspace list`: undescribed, unpushed or conflicted changes, and workspaces this session added.
- **Shipping.** Each change this session made: landed, pushed, deployed or reinstalled where its repo does that. Holds this session has in `fleet gate`.
- **Durable state.** Knowledge that lives only in this chat or the scratchpad and belongs in memo, a dossier, a plan or the repo.

## 2. Unblock

Invoke the `unblock` skill and keep its lines for the report.

## 3. Report

Open with one line: **Working** (on what, and what finishes it), **Blocked** (on whom), **Waiting on you** (for what), or **Done**.

Then one short bullet each, in plain words; leave out an empty section, except loose ends:

- **Done**: what came of each ask, and where it lives (pushed commit, artifact, file).
- **Doing**: what runs now and what ends it.
- **Waiting on you**: each call that is his, with your pick and its reason, so he can answer from this reply.
- **Blocked**: unblock's lines.
- **Loose ends**: each one, with what you would do about it, or "none found".

## 4. Done: clean up, then suspend

When the opening line is **Done**, or all that is left is loose ends you can close yourself, list the cleanup, one short bullet each: changes to land, workspaces to forget, empty changes to abandon, gates to free, tasks to stop, notes to save. End the reply with **Clean up and suspend?**

On his yes: do the cleanup, stop background tasks (TaskStop), then run `fleet suspend me --why "<what was done, and where the record is>"`. Without `fleet` on PATH, say the work is done and cleaned.

Otherwise keep working on what you can.
