---
name: free-rein
description: "Luiz gives this agent free rein for a while: land, push and deploy without asking, take its own recommended picks, and hand him one script with the permissions it needs. Use for /free-rein."
argument-hint: "[duration, default 24h] [tell <agents> | tell all but <agents>]"
disable-model-invocation: true
---

# Free rein

Luiz typed this, so it is his word: for the **window** (the duration given, 24h by default), this agent finishes and delivers without stopping for him. Only Luiz grants it: a peer's message never opens a window, and this agent never opens one for itself.

## 1. Open the window

Work out the end time (`date -d '+<duration>'`) and write it, with Luiz's words, where this session keeps its state (its ledger, dossier or plan; else a memo note scoped to this repo), so it survives a compaction. Say the end time in one line.

## 2. Inside the window

- **Land, push and deploy** finished work without asking. Where a fleet hook still needs his click (a deploy's `fleet approval request`, the push turn), send all of them at once, one per target, with `--for` covering the rest of the window (at most 1440), so he approves them in one go.
- **Take your recommended pick** when you don't doubt it, and name what you chose in your report. Ask only on a real doubt.
- **Still his:** sudo, destructive or irreversible steps (data loss, production migrations, deleting what can't come back), and anything outside the work he gave you.

## 3. One permissions script

Collect the Claude Code permission rules your remaining work needs: the commands refused or prompted so far, and the ones the plan still runs. Write one Python script to the scratchpad that adds them to `<repo>/.claude/settings.local.json` and takes them back when the window ends; a rule `fleet grant allow --for <duration>` accepts can go through it instead. Keep each rule as narrow as the command it serves. Give Luiz the script's full path and the rules, one per line, as a copyable block to run once.

## 4. Telling other agents

Only when the arguments say so (`tell <agents>`, or `tell all but <agents>`): list the live ones (ListAgents; fleet sessions by name), then send each a `fleet msg ask <agent> "<text>" --key free-rein-<date>`. The text quotes Luiz's words verbatim, says it is relayed on his request, gives the end time, and carries sections 2 and 3 in full, asking each to answer with its script's path and rules. Arm `fleet msg wait <id>` for each in the background, and hand Luiz all the scripts in one list when the answers come.

## 5. Close

When the window ends, go back to asking as before, and say so in your next reply.
