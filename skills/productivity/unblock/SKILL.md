---
name: unblock
description: "Find what blocks this session's work and what this session blocks, then ask each owning agent for the action that delivers it. Use for /unblock, or when /heads-up runs."
disable-model-invocation: true
---

# Unblock

A **blocker** is a step one party waits on before its work can go on: a lane landing, a push, a deploy, an answer, an approval, a gate. Each has an **owner**, the one party that can clear it. Find every blocker in both directions, and put each in front of its owner with the exact action that clears it.

## 1. Find the blockers (read-only)

**What this session waits on:**
- Its plans, ledger or dossier: incoming lane edges and waits whose lane has not landed.
- Its open asks: `fleet msg ls`, and any ask sent by SendMessage with no answer.
- Its own steps that stalled on something outside it: a gate held by another run, a push refused, an approval pending, a deploy someone else runs.

**What waits on this session:**
- `fleet msg mailbox`: the asks this session still owes.
- `fleet waiting`: items naming this session's work.
- Plans or news naming this session's lane as one they wait on.

For each blocker note its owner, the action that clears it, and since when it has waited.

## 2. Put each blocker in front of its owner

- **Another agent owns it.** Ask for the action, specific enough to do without asking back: `fleet msg ask <agent> "<action>: <what it unblocks, and for whom>" --key unblock-<blocker>`. The key joins an existing thread instead of opening a second one. For an agent of this session's own team, SendMessage does the same. When the owner is suspended (`fleet suspended`), do not resume it: the resume is Luiz's call, so it goes under his blockers with your pick.
- **This session owns it.** Deliver it now when you can, then answer the asker's thread with what was done (`fleet msg answer <thread> "<done, where>" --final`). When you cannot yet, answer with what it waits on.
- **Luiz owns it.** It is his call: name it with your pick and the reason.

The step is done when every blocker has an ask, an answer or a line for Luiz.

## 3. Report

One line per blocker: what waits, on whom, since when, and what you did (asked, with the thread id; delivered; or put to Luiz). Say "no blockers" when there are none.
