---
name: worktree-janitor
description: Shape a messy jj @ into a clean, described stack (split by intent, fixups absorbed, conflicts resolved, repo-style messages, empty @ on top), then audit it mechanically. Use before landing or pushing a jj stack, and when @ holds unrelated edits, lacks a description, or carries conflicts.
---

# Worktree janitor

Spawn the worktree-janitor agent on the stack, then audit what it did with code, not by reading its report. The agent owns the judgement (what the intents are, how to word them); this skill owns the leash.

## Scope

The stack from the nearest bookmark or immutable revision below `@` up to `@`: the audit's default base, `heads(::@ & (immutable() | bookmarks()))`. When the caller names a base revision, use it as `--from <rev>` in every audit call.

`janitor-audit` is on the Bash PATH through the plugin's `bin/`; otherwise it is `scripts/janitor-audit` in the plugin root.

## Steps

1. **Record the start**: `janitor-audit start [--from <rev>]` from inside the workspace. It snapshots `@`, prints the operation id (the _start op_), the scope revset, its revisions, files and conflicted paths. An empty scope, or one whose only revision is an empty `@`, is already clean: say so and stop.
2. **Spawn** the agent (`subagent_type: tstack:worktree-janitor`) with only: the workspace path, the scope revset from step 1, any trailer the caller wants on new messages (a `Claude-Session:` line, say), and, when the caller asked for per-revision checks, the check command. Its rules live in the agent; leave them out of the brief.
3. **Audit**: `janitor-audit check --op <start op> [--from <rev>] [--check "<cmd>"]`. It passes only when every check holds:
   - _tree_: the tree of `@` equals the start's, except paths conflicted at the start; each resolution is printed with its diff.
   - _base_: the base is still an ancestor of `@`, unchanged, so nothing immutable or below the stack was rewritten.
   - _bookmarks_: no bookmark on the stack moved, appeared or vanished.
   - _stack_: every revision described, non-empty (merges aside), conflict-free; `@` empty and undescribed.
   - _strays_: no new revision left that nothing reaches.
   - _style_: every message the agent wrote matches the prefix habit of the last 30 subjects below the stack; placeholders (`WIP`, `fixup!`) fail. Notes (an unseen type, a long subject) are yours to judge.
   - _checks_ (only with `--check`): the command passes on every revision's tree.

   Then read what the code cannot grade: each resolution's diff against the agent's one-line reason, and each message's tone against `jj log`. A resolution that drops a side's intent, or a message that misdescribes its diff, is a failed audit too.
4. **On a failed audit**: `jj op restore <start op>`, then spawn the agent once more with the same scope plus one line naming each fault. Audit again. A second failure is not retried: restore the start op again and report (the failed attempt stays in `jj op log` for a look).
5. **Report** to the user in plain words: the new stack (change id, subject, files, checks), each conflict and how it was resolved, what is left in `@`, whether a rerun happened and why, and the undo line `jj op restore <start op>`. On a second failure, say what failed and that the repo is back as it was.
