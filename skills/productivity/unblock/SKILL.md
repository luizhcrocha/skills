---
name: unblock
description: "Find what blocks this session and what it blocks, and put each blocker in front of its owner with the action that clears it. Use when work stalls on another agent, a gate, a push or an approval, when another agent waits on this session, or for /unblock."
---

# Unblock

A **blocker** is a step one party waits on before its work can go on: a lane landing, a push, a deploy, an answer, an approval, a gate. Its **owner** is the one party that can clear it. Find every blocker in both directions and put each in front of its owner with the exact action that clears it. The `fleet` commands run when `fleet` is on PATH; `<me>` is this session's name.

## 1. Find the blockers

For each, note its owner, the action that clears it, and since when it waits. Check each blocker at its source first (`jj git fetch`, then the commit on `<bookmark>@origin`; the deploy's own status): one already cleared is dropped, and the work goes on.

**This session waits on:**
- Lanes its plan, its `holds.md`, ledger or dossier waits on that have not landed.
- Its open asks: `fleet msg ls --from <me>`, and each ask to its own subagents without an answer.
- Its steps stalled outside it: a gate another run holds, a refused push, a pending approval, a deploy someone else runs.
- Luiz: its fleet's rows in `fleet waiting`. A row marked ANSWERED has his answer: act on it.

**Waits on this session:**
- `fleet msg mailbox`: the asks it still owes.
- Plans or news naming its lane as one they wait on.

## 2. Put each blocker in front of its owner

- **Another agent.** `fleet msg ask <agent> "<action>: <what it unblocks, for whom>" --key unblock-<blocker>`, specific enough to do without asking back; the key reuses an open thread. Then work on what does not depend on it, or end the turn: the answer arrives in your mailbox and its delivery wakes you. A subagent this session spawned gets SendMessage; every other session goes through `fleet msg`. A suspended owner (`fleet suspended`) stays suspended: its resume is Luiz's call.
- **Still open the next time you wake.** Check the source again. Cleared: go on, and `fleet msg cancel <thread>`. Still blocked: ask again once with the same `--key` (it joins the thread and wakes the owner), naming how long it has waited. Still open after that: it is Luiz's, the blocker, its owner, since when and both asks, as the reply's last line.
- **This session.** Deliver it now, then answer the asker: `fleet msg answer <thread> "<done, where>" --final`. When it cannot be delivered yet, answer with what it waits on.
- **Luiz.** Name the call, your pick and its reason.

Done when every blocker has an ask, an answer or a line for Luiz.

## 3. Report

One line per blocker: what waits, on whom, since when, and what you did (asked, with the thread id; delivered; put to Luiz). "No blockers" when there are none.
