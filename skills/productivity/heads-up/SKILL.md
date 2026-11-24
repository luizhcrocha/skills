---
name: heads-up
description: "A session's own status report for Luiz: done, doing, blocked, waiting on him, and loose ends; when nothing is left, offer cleanup, then suspend. Use for /heads-up."
disable-model-invocation: true
---

# Heads-up

Luiz is checking on this session from outside, in a fleet. Catch him up as [`/ketchup`](../ketchup/SKILL.md) does (its voice, its list of what waits on him), but over the whole session, not only since his last message, and add what ketchup leaves out:

1. **Loose ends**: each ask of his not done, each promise without follow-through, each agent report not acted on, each undescribed, unpushed or conflicted jj change, and knowledge that lives only in this chat. Close the ones you can now; the rest become steps.
2. **Blockers**, checked live: run the [`unblock`](../unblock/SKILL.md) skill's steps in this turn. A blocker another agent owns goes to it with `fleet msg ask <owner> "<diagnosis>"`.
3. **Open with one marker**: 🟢 Working, ⛔ Blocked (on whom), 🙋 Waiting on you (for what) or ✅ Done; then the steps left, each one Luiz must take in bold with your pick.
4. **Cleanup, then suspend.** Only when your own work is done (✅, or 🙋 with only his steps left): list the scaffolding to clean (workspaces, empty changes, gates, background tasks) and ask **Clean up and suspend?** With `fleet` on PATH, ask it as `fleet msg decide --body "<the list>" --question "Clean up and suspend?" --option Yes --option No --key cleanup-suspend`, key and labels word for word: Luiz can then grant Yes for 24 hours, and the grant answers every session's next one. Without `fleet`, end the reply with the question. On his yes, clean up, stop background tasks (TaskStop), and run `fleet suspend me --why "<what was done, where the record is, what waits>"`. Without `fleet` on PATH, say the work is done and cleaned.
