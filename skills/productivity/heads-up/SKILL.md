---
name: heads-up
description: "A session's own status report for Luiz: done, doing, blocked, waiting on him, and loose ends; when nothing is left, offer cleanup, then suspend. Use for /heads-up."
disable-model-invocation: true
---

# Heads-up

Luiz is checking on this session from outside. Tell him where it stands, and find the loose ends: anything nobody will pick up once the session ends. `/ketchup` covers what changed since his last message; a heads-up covers the whole session.

## 1. Sweep

Read only. Done when each source has a note, "nothing" included:

- **His asks.** Each request Luiz made: done, in progress, dropped, or replaced by a later ask. A plan or an offer in reply leaves the ask open.
- **Promises.** Each "I'll …", "next …" and offer this session made without follow-through.
- **Agents and tasks.** Each subagent and background task: running, finished with a report not yet acted on, or stopped.
- **History.** `jj st` and `jj log -r 'trunk()..@'` in each workspace this session used, and `jj workspace list`: undescribed, unpushed or conflicted changes, and workspaces this session added.
- **Shipping.** Each change this session made: landed, pushed, deployed or reinstalled where its repo does that. Holds this session has in `fleet gate`.
- **Durable state.** Knowledge that lives only in this chat or the scratchpad and belongs in memo, a dossier, a plan or the repo.

## 2. Unblock

Run the `unblock` skill's steps in full, in this turn, and keep its lines for the report. The sweep is the record; this step is **live**: every blocker is checked at its source now (the run, the job, the service, the commit on origin), never reported from the ledger, a plan or an owner's last message. A heads-up that says ⛔ Blocked with a blocker it did not check live is premature: Luiz would have to run `/unblock` after it (2026-11-19: a heads-up said "orch reruns n5 and n6"; the rerun n12 already existed, was dead in Nomad, and the adapter stalled on a missing pool socket).

Act on each blocker as unblock says: clear what this session can in this turn, and send the rest to its owner with the diagnosis. The report comes after; a blocker the session could have cleared is not reported as ⛔ Blocked.

Done when each blocker's line names what was checked live, what it showed, and what was done about it.

## 3. Report

Lead with what happens next, then the record. Shape, in this order:

1. **Opening line**, bold, with a marker: 🟢 **Working**, ⛔ **Blocked** (on whom), 🙋 **Waiting on you** (for what) or ✅ **Done**, then whether Luiz is needed now, e.g. "🟢 Working. Nothing needs you yet."
2. **Next, in order**: numbered steps until the work is finished, each "what happens → what follows". Mark each step that needs Luiz with 🙋 and bold, with your pick and its reason, so he can answer from the reply. Loose ends become steps too, each with what you would do; a loose end with no step is still forgotten.
3. **Where each piece stands**: a table, one row per piece of work (each ask, lane or change): `Work | State | Next`. State is ✅ done (with where it lives: commit, artifact, file), 🔄 running (how far) or ⏸ not started; Next names its step number, or n/a.
4. **Blocked**: unblock's lines, or "nothing".

Plain words, one line per step or row. Leave out the steps when the report is ✅ Done.

## 4. Finish, clean up, then suspend

Work comes before the offer. Every loose end you can close yourself (a page to update, notes to save, a change to land, a report to act on) is work: do it now, as steps of this turn, and report it done. An offer to suspend with such work still listed is premature.

**Cleanup** is only the session's scaffolding: workspaces to forget, empty changes to abandon, gates to free, background tasks to stop.

- **✅ Done** (no step left for anyone): list the cleanup, one short bullet each, and end the reply with **Clean up and suspend?**
- **🙋 Waiting on you**, with only Luiz's steps left and your own work finished: list the cleanup and end with **Suspend until you <his step>?** On his yes, the `--why` names his step and what the session does once it is taken.
- **🟢 Working** or **⛔ Blocked**: no offer; keep working on what you can.

On his yes: do the cleanup, stop background tasks (TaskStop), then run `fleet suspend me --why "<what was done, where the record is, and what waits>"`. Without `fleet` on PATH, say the work is done and cleaned.
