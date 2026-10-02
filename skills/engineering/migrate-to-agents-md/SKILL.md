---
name: migrate-to-agents-md
description: Move a repo's agent instructions from CLAUDE.md into AGENTS.md, so Claude Code and every other coding agent read one file and no CLAUDE.md shadows it. Run when a repo has a CLAUDE.md, when CLAUDE.md and AGENTS.md both exist, or when Claude ignores an AGENTS.md.
disable-model-invocation: true
---

# Migrate to AGENTS.md

Claude Code reads `AGENTS.md` natively, but only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` sits in the working directory or above it. Any of those three shadows it ([docs](https://code.claude.com/docs/en/memory#agents-md)). The end state is one `AGENTS.md` per directory that has instructions, and no project `CLAUDE.md` beside it. Other agents (Codex, Cursor, …) read the same file.

`~/.claude/CLAUDE.md`, a managed `CLAUDE.md` and `.claude/rules/` don't shadow anything. Leave them alone.

## 1. Inventory

From the repo root, list every instruction file, tracked or not, at any depth:

```sh
fd -H -t f -t l '^(CLAUDE|CLAUDE\.local|AGENTS)\.md$' --exclude .git --exclude .jj --exclude node_modules
```

For each one, record:

- whether it's a symlink (`readlink`), and its target
- whether a `CLAUDE.md` holds an `@AGENTS.md` import, or only a sentence telling Claude to read `AGENTS.md`
- whether it's tracked (`jj file list <path>`). `CLAUDE.local.md` is personal and normally untracked.

Then look for workarounds and readers outside the files themselves:

- `SessionStart` hooks that print `AGENTS.md` (`.claude/settings.json`, plugin `hooks/`)
- `claudeMdExcludes` patterns that name `CLAUDE.md`
- `InstructionsLoaded` hooks: they don't fire for an `AGENTS.md` that Claude reads directly
- every mention of `CLAUDE.md` in the repo: `rg -n 'CLAUDE\.md' --hidden -g '!.git' -g '!.jj'`. Scripts, CI, READMEs and skills that read or name it need updating too.

Run `claude --version`. Reading `AGENTS.md` directly needs v2.1.277 or later, and v2.1.281 or later for every session type. On an older version, stop: the right shape there is a `CLAUDE.md` that holds `@AGENTS.md`, not a migration.

Done when every file and reference is in one table: path, kind, plan.

## 2. Plan per directory

| State in the directory | Plan |
| :- | :- |
| `CLAUDE.md` only | Rename it to `AGENTS.md`. |
| `.claude/CLAUDE.md` only | Move it to `AGENTS.md` beside `.claude/`, where other agents also find it. |
| `CLAUDE.md` is a symlink to `AGENTS.md` | Delete the symlink. |
| `CLAUDE.md` holds `@AGENTS.md` and nothing else | Delete `CLAUDE.md`. |
| `CLAUDE.md` holds `@AGENTS.md` plus more | Merge the rest into `AGENTS.md`, then delete `CLAUDE.md`. |
| Both, no import | Merge `CLAUDE.md` into `AGENTS.md`, then delete `CLAUDE.md`. |
| `CLAUDE.md` tells Claude in words to read `AGENTS.md` | Drop that sentence, merge the rest, delete `CLAUDE.md`. |
| `AGENTS.md` only | Nothing to move. |

To merge, keep `AGENTS.md`'s structure and add each `CLAUDE.md` rule it doesn't already state. Where the two files contradict each other, ask the user which rule wins; don't pick. A rule that only makes sense to Claude Code (Claude tools, `/commands`, `.claude/` paths) still goes in, worded so that other agents can skip it.

A `CLAUDE.local.md` has no `AGENTS.local.md` counterpart, because Claude doesn't read `AGENTS.local.md`. Offer the user two fixes and let them pick:

- Move its rules into `~/.claude/CLAUDE.md` (every repo) and delete it.
- Keep it, and set **Project instructions** to `claude-md-and-agents-md` in `/config`. That's user settings; project settings ignore it.

A `SessionStart` hook that prints `AGENTS.md` goes, because Claude would read the file twice. Note any `InstructionsLoaded` hook, and any reliance on `--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, as behaviour the migration changes.

Show the user the plan table and the merged text of each `AGENTS.md`. Done when the user approves it.

## 3. Apply

Work in one jj change. Rename with `mv` (jj tracks the rename from the snapshot), not with a symlink: Windows clones check a committed symlink out as a one-line text file, and Claude's Edit and Write tools refuse to write through one.

Update every reference from the inventory so that it names `AGENTS.md`. Leave references to `~/.claude/CLAUDE.md` alone, because that file stays.

Done when the inventory command finds no project `CLAUDE.md` or `.claude/CLAUDE.md`, and `rg 'CLAUDE\.md'` turns up only intended mentions.

## 4. Verify

Start a fresh session in the repo. The first one after a Claude Code upgrade may still skip `AGENTS.md`. Run `/memory` and confirm that each `AGENTS.md` path is listed. If one is missing, walk the docs' "My AGENTS.md isn't loading" checklist: a `CLAUDE.md` higher up the path, the version, or **Project instructions** set to `claude-md` or `managed-only`.

Describe the change (`docs: move agent instructions to AGENTS.md`) and hand it to the Land playbook, or leave it for the user to land.

**Reply:** the plan table as applied, the merges and the rule conflicts the user settled, the references updated, what changed in behaviour (hooks, `--add-dir`), the `/memory` check, and the change id.
