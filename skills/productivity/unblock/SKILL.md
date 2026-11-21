---
name: unblock
description: "Find what blocks this session and what it blocks, and put each blocker in front of its owner with the action that clears it. Use when work stalls on another agent, a gate, a push or an approval, when another agent waits on this session, or for /unblock."
---

# Unblock

A **blocker** is a step one party waits on before its work can go on: a lane landing, a push, a deploy, an answer, an approval, a gate. Its **owner** is the one party that can clear it. Find every blocker in both directions and put each in front of its owner with the exact action that clears it. The `fleet` commands run when `fleet` is on PATH; `<me>` is this session's name.

## 1. Find the blockers

For each, note its owner, the action that clears it, and since when it waits. Check each blocker **live**, at its source, before writing it down: the commit on `<bookmark>@origin` after `jj git fetch`; the deploy's own status; for a run, job or rerun another party owes, the run itself (its id, queue state, placement, exit) and the service it runs on. A wait on someone else's step ends when that step has started: follow it to where it is now (queued too long, dead, red) rather than reporting the owner's promise. One already cleared is dropped, and the work goes on; one stuck at its source is a new blocker, with its own owner.

**This session waits on:**
- Pieces its handoff waits on (the other piece its `next` line names) that have not landed.
- Its open asks: `fleet msg ls --from <me>`, and each ask to its own subagents without an answer.
- Its steps stalled outside it: a gate another run holds, a refused push, a pending approval, a deploy someone else runs. A `fleet land` that was refused or will not finish → `fleet:pool-land`; a run that waits too long on the pool → `fleet:pool-diagnose`.
- Luiz: its questions to him, `fleet msg ls --from <me> --kind decision`. His answer arrives in `fleet msg mailbox` as a choice: act on it.

**Waits on this session:**
- `fleet msg mailbox`: the asks it still owes.
- Plans or news naming its lane as one they wait on.

## 2. Put each blocker in front of its owner

- **Clear it yourself first.** A blocker is work, not a report: diagnose it to its cause, and when the fix is in reach, do it in this turn (a rerun you can start, a service you run, your own code, a stale lock or socket you can check and restart, a question the repo or the logs answer). In another agent's lane, deliver the diagnosis and the fix with the ask, so the owner acts without digging. `sudo` and destructive steps go to Luiz, as a command he can copy. Ask the owner only for what needs them.
- **Another agent.** `fleet msg ask <agent> "<action>: <what it unblocks, for whom>" --key unblock-<blocker>`, specific enough to do without asking back; the key reuses an open thread. Then work on what does not depend on it, or end the turn: the answer arrives in your mailbox and its delivery wakes you. A subagent this session spawned gets SendMessage; every other session goes through `fleet msg`. A suspended owner (`fleet suspended`) stays suspended: its resume is Luiz's call.
- **Still open the next time you wake.** Check the source again. Cleared: go on, and `fleet msg cancel <thread>`. Still blocked: ask again once with the same `--key` (it joins the thread and wakes the owner), naming how long it has waited. Still open after that: it is Luiz's, the blocker, its owner, since when and both asks, as the reply's last line.
- **This session.** Deliver it now, then answer the asker: `fleet msg answer <thread> "<done, where>" --final`. When it cannot be delivered yet, answer with what it waits on.
- **Luiz.** Name the call, your pick and its reason.

Done when every blocker is cleared, or has an ask carrying its diagnosis, an answer, or a line for Luiz.

## 3. Report

One line per blocker: what waits, on whom, since when, and what you did (cleared, and how; asked, with the thread id; delivered; put to Luiz). "No blockers" when there are none.
