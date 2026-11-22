---
name: rename-yourself
description: "Name this session in its Rex tab and Claude Code (/rename). Use for /rename-yourself, \"rename yourself\", or once the work has a name and the session has none of its own."
argument-hint: "[name]"
---

# Rename yourself

The session and its tab get the same short name. Then Luiz can find the work in the Rex tab bar and in `claude --resume`.

## 1. Pick the name

- If Luiz gave a name, use it as he wrote it.
- If not, name the work, not the tool: 2 to 4 words in kebab-case, for example `memo-redesign` or `rex-tab-moves`. Use the repo's terms from `CONTEXT.md` when it has them.

## 2. Check that you are in Rex

`REX_SESSION` and `REX_BLOCK` must be set. If they are not, skip step 3, and in step 4 ask Luiz to type `/rename <name>` himself instead of sending it.

Find your window from your own block, not from the focused one. Luiz may be looking at another tab:

```bash
win=$(rex whoami --json | jq -r .window_id)
```

## 3. Rename the tab

```bash
rex window rename -s "$REX_SESSION" "$win" "<name>"
```

## 4. Send /rename to your own pane

Skip this step when Claude Code already holds the name. A `/rename`, and fleet's `--name` at launch, write a `custom-title` line to the session's transcript; the last one is the current name:

```bash
jq -r 'select(.type == "custom-title") | .customTitle' ~/.claude/projects/*/"$CLAUDE_CODE_SESSION_ID".jsonl 2>/dev/null | tail -n 1
```

If it prints `<name>`, go to step 5. The status-line title Claude Code makes up on its own is not a name, and this check ignores it.

Claude Code reads `/rename` only from its input box, so type it there through rex:

```bash
rex send -b "$REX_BLOCK" "/rename <name>"
rex send-key -b "$REX_BLOCK" enter
```

Your turn is still running, so Claude Code queues the command and runs it when the turn ends. Do these two calls last, and end the turn right after them.

Text that Luiz has typed but not sent is in the same input box, and `rex send` adds to it. If he invoked this skill, the box is empty. If you rename yourself on your own initiative, read the bottom of the pane first with `rex capture -b "$REX_BLOCK" | tail -n 15`. If the input line has text, skip step 4 and ask him to run `/rename <name>`.

## 5. Report

Luiz reads your reply after the turn ends, when a queued `/rename` has already run. So report the rename as done, in one line: "Named this session `<name>` (Rex tab and Claude Code)." Leave out the queue, the input box and the end of the turn, and say nothing of a step you skipped because it was already done: Luiz reads those as work still pending.

The one case with something for Luiz to do is a `/rename` you left to him in step 2 or 4. Then the line asks for it and nothing else: "Type `/rename <name>` to name this session."
