---
name: unblock
description: "Find what blocks this session and what it blocks, and put each blocker in front of its owner with the action that clears it. Use when work stalls on another agent, a gate, a push or an approval, when another agent waits on this session, or for /unblock."
---

# Unblock

A **blocker** is a step one party waits on before its work can go on: a lane landing, a push, a deploy, an answer, an approval, a gate. Its **owner** is the one party that can clear it. Find every blocker in both directions and put each in front of its owner with the exact action that clears it. The `fleet` commands run when `fleet` is on PATH; `<me>` is this session's name.

## 1. Find the blockers

For each, note its owner, the action that clears it, and since when it waits.

**This session waits on:**
- Lanes its plan, ledger or dossier waits on that have not landed.
- Its open asks: `fleet msg ls --from <me>`, and each SendMessage ask without an answer.
- Its steps stalled outside it: a gate another run holds, a refused push, a pending approval, a deploy someone else runs.
- Luiz: its fleet's rows in `fleet waiting`. A row marked ANSWERED has his answer: act on it.

**Waits on this session:**
- `fleet msg mailbox`: the asks it still owes.
- Plans or news naming its lane as one they wait on.

## 2. Put each blocker in front of its owner

- **Another agent.** `fleet msg ask <agent> "<action>: <what it unblocks, for whom>" --key unblock-<blocker>`, specific enough to do without asking back; the key reuses an open thread. An agent of this session's own team gets SendMessage. A suspended owner (`fleet suspended`) stays suspended: its resume is Luiz's call.
- **This session.** Deliver it now, then answer the asker: `fleet msg answer <thread> "<done, where>" --final`. When it cannot be delivered yet, answer with what it waits on.
- **Luiz.** Name the call, your pick and its reason.

Done when every blocker has an ask, an answer or a line for Luiz.

## 3. Report

One line per blocker: what waits, on whom, since when, and what you did (asked, with the thread id; delivered; put to Luiz). "No blockers" when there are none.
