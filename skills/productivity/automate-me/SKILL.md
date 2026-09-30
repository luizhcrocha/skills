---
name: automate-me
description: Refresh /tuca-mode from how Luiz actually works, mined from his recent Claude Code transcripts, as jj changes for him to review.
disable-model-invocation: true
argument-hint: "[projects to mine] [since YYYY-MM-DD]"
---

# Automate me

Mine Luiz's recent Claude Code sessions for how he actually works (the corrections he keeps making, the defaults he keeps rejecting, the instructions he keeps repeating) and turn what recurs into proposed edits to `/tuca-mode`, its playbooks, and the global `CLAUDE.md`. The output is one jj change per repo, for Luiz to review; nothing lands. Adapted from poteto's pstack (MIT).

There is one mode, `tuca-mode`: this skill refines it and never creates another. A narrow workflow that surfaces here ("how I write commit messages") is a proposal for its own skill, named in the report, not a section of the mode.

## 1. Scope

- **Projects**: the ones Luiz names, else the current one. Each is a path; its jj workspaces beside it (`<repo>-<lane>`) come along through `--workspaces`. Never read another project's transcripts: they may hold client data this task has no reason to see.
- **Window**: Luiz's date, else everything since tuca-mode last changed in the tstack checkout: `jj log -R ~/repos/luizhcrocha/skills -r 'latest(::trunk() & files(root:"skills/engineering/tuca-mode"))' --no-graph -T 'committer.timestamp().format("%Y-%m-%d")'`.
- **The extractor**: `${CLAUDE_PLUGIN_ROOT}/skills/productivity/automate-me/scripts/human-turns`. Transcripts live in `~/.claude/projects/<slug>/<session>.jsonl` (the slug is the path with `/` and `.` as `-`), subagent transcripts in `<session>/subagents/`. It prints Luiz's own turns as JSONL (`session`, `date`, `cwd`, `text`, and `prev`, the tail of the reply the turn answers) and drops harness noise, peer messages and headless `claude -p` runs. Subagent transcripts carry the lead's briefs, not Luiz's words, so they stay out unless a finding needs to see what a worker was told (`--subagents`).

Run `human-turns --project <path> --workspaces --since <date> --list` and show Luiz the count: sessions and turns per project. Done when the projects and the window are fixed.

## 2. Extract and batch

Write the turns to the scratchpad (`human-turns ... > <scratchpad>/automate-me/turns.jsonl`) and split them into batches of whole sessions, about 150 turns each, one file per batch. Done when every session is in exactly one batch file.

## 3. Fan out the readers

One reader per batch, all spawned in one message: `general-purpose`, `model: "sonnet"`, `run_in_background: true`. Each brief carries its batch file's path and this, verbatim:

> Read every turn in the batch file. Each turn is Luiz's own words; `prev` is the reply he answered. Find what recurs in how he works: corrections (he undoes or redirects something the agent did), rejected defaults (a tool, command, format or habit he turns down), preferences (length, tone, format, language, shell), repeated instructions (he says the same thing again in a new session), verification posture (what "done" means to him), delegation (models, subagents, parallelism), and process (jj, landing, pushes, reviews). For a single turn you cannot read without more context, open that session's transcript (`~/.claude/projects/*/<session>.jsonl`) and read around it; nothing else.
>
> Return a list of patterns. Each: a one-line statement of the rule as Luiz would state it; the evidence, one row per instance (session id, date, a paraphrase of what he said and what it answered); and `mechanical: yes` when the rule could be checked by code (a lint, a hook, a script, a CLI flag) rather than judged. Paraphrase every instance: no client, person or case names, no document contents, no secrets. A pattern seen once is still reported, marked `once`. Write nothing.

A reader that returns nothing drops out: note it and continue. Done when every reader has returned or dropped out.

## 4. Sort the signal

You own this step (judgement). Merge the readers' patterns, then keep a pattern only when:

- it recurs across **two or more sessions** (the same session twice is one instance), and nothing later in the window contradicts it. A contradicted pattern goes to Luiz as a question, not a rule;
- it is **not already said**: read the current `skills/engineering/tuca-mode/SKILL.md`, the playbooks it names, `~/repos/luizhcrocha/dotfiles/default/claude/CLAUDE.md`, and memo's `preference` notes (`tstack:recall`). A rule already written but still being corrected is a finding too: its wording failed, so sharpen it per `tstack:writing-for-agents` (a stronger leading word, a positive target) rather than restating it.

Route each survivor to one home:

| The rule applies | Home |
|---|---|
| to every session, in any repo, mode on or off | global `CLAUDE.md` in the dotfiles repo |
| to how the mode works: autonomy, subagents, replies, non-negotiables | `tuca-mode/SKILL.md` |
| to one kind of task | that playbook |
| and code could check it (`mechanical: yes`) | a structure proposal, per `tstack:principles`' Encode Lessons in Structure: the strongest mechanism that fits (a hook, a lint, a `land-check` rule, a script flag), with where it would live. The prose rule is dropped once the mechanism exists. |
| to one repo only | that repo's `CLAUDE.md`, named as a proposal in the report |

Done when every pattern is kept with a home, or dropped with its reason.

## 5. Confirm with Luiz

Mining misses intent. One `AskUserQuestion` round: the kept rules as multi-select options, grouped by home (four at most per question, two or three questions), so Luiz ticks what is really him. Then one free-form question for anything the list missed. Contradicted patterns go in the same round, as either-or questions. Done when every kept rule is confirmed or cut.

## 6. Draft the edits

One jj workspace per repo touched, off its landing bookmark:

- tstack: `jj workspace add ../skills-automate-me -r master --name automate-me` from `~/repos/luizhcrocha/skills`.
- dotfiles: `jj workspace add ../dotfiles-automate-me -r nix --name automate-me` from `~/repos/luizhcrocha/dotfiles`.

Edit in place per `tstack:writing-for-agents` and `tstack:unslop`: preserve what Luiz has not contradicted, revise what has new evidence, add a rule only for a genuinely new habit. The mode stays terse; each rule is a line, operational, and says "Luiz" where the mode already does. Other skills appear as pointers, never as pasted excerpts.

Describe each change in the repo's style (`jj log`), with an evidence section in the body: per rule, the file it went to and its instances as `<session id> <date>: <paraphrase>`. Then `jj new`. Done when each repo has one described change and an empty `@` on top.

## 7. Hand over

Leave the workspaces in place for Luiz. No landing, no push, no bookmark move.

**Reply:** per repo, the change id and workspace path; the rules added, sharpened and removed, each with its home and instance count; the structure proposals (mechanism, where it lives, the rule it replaces); rules proposed for a repo's own `CLAUDE.md` or a skill of their own; what was dropped as a one-off or contradicted; the sessions and turns read, and dropouts. A dotfiles change takes effect after Luiz's next home-manager switch.
