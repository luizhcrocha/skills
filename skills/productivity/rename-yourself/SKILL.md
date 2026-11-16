---
name: rename-yourself
description: "Name this session in its Rex tab and Claude Code (/rename). Use for /rename-yourself, \"rename yourself\", or once the work has a name and the tab shows `Window <id>`."
argument-hint: "[name]"
---

# Rename yourself

The session and its tab get the same short name. Then Luiz can find the work in the Rex tab bar and in `claude --resume`.

## 1. Pick the name

- If Luiz gave a name, use it as he wrote it.
- If not, name the work, not the tool: 2 to 4 words in kebab-case, for example `memo-redesign` or `rex-tab-moves`. Use the repo's terms from `CONTEXT.md` when it has them.

## 2. Check that you are in Rex

`REX_SESSION` and `REX_BLOCK` must be set. If they are not, skip steps 3 and 4. Tell Luiz the name and ask him to type `/rename <name>` himself.

Find your window from your own block, not from the focused one. Luiz may be looking at another tab:

```bash
win=$(rex whoami --json | jq -r .window_id)
```

## 3. Rename the tab

```bash
rex window rename -s "$REX_SESSION" "$win" "<name>"
```

## 4. Send /rename to your own pane

Claude Code reads `/rename` only from its input box, so type it there through rex:

```bash
rex send -b "$REX_BLOCK" "/rename <name>"
rex send-key -b "$REX_BLOCK" enter
```

Your turn is still running, so Claude Code queues the command and runs it when the turn ends. Do these two calls last, and end the turn right after them.

Text that Luiz has typed but not sent is in the same input box, and `rex send` adds to it. If he invoked this skill, the box is empty. If you rename yourself on your own initiative, read the bottom of the pane first with `rex capture -b "$REX_BLOCK" | tail -n 15`. If the input line has text, skip step 4 and ask him to run `/rename <name>`.

## 5. Report

In one line, give the name and say that the tab is renamed and `/rename` is queued for the end of the turn.
