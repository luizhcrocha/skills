---
name: reflect
description: Mine this session's transcript for durable learnings through three reviewers and a synthesizer, then land the approved skill edits as a jj change in the tstack repo and the rest as memo notes.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits. Adapted from poteto's pstack (MIT).

## When to run

Only when Luiz says "reflect" or runs `/tstack:reflect`. Skip when the conversation is trivial, off-topic, or already covered by an existing skill the session followed correctly, and say so in one line. One-offs are not learnings.

## 1. Locate the active transcript

Find this session's own transcript before fanning out:

```
python3 ${CLAUDE_PLUGIN_ROOT}/skills/productivity/recall/scripts/sessions.py path ${CLAUDE_SESSION_ID}
```

Claude Code keeps a session at `~/.claude/projects/<slug>/<session-id>.jsonl` (`$CLAUDE_CONFIG_DIR` in place of `~/.claude` when set; the slug is the launch directory with every character other than a letter or digit turned into `-`), and its subagents' transcripts at `<slug>/<session-id>/subagents/agent-<id>.jsonl`, each with a `.meta.json` naming the agent type, description and model. The script looks the id up in this project's folders and opens no other session's file. Never glob or read across `~/.claude/projects/*/`: that reads private work from unrelated projects.

Check the first record that carries a `sessionId` matches `${CLAUDE_SESSION_ID}`. If no path resolves, write a tight digest of the session and pass that instead. A long transcript stays with the reviewers: they read it, you pass the path. `sessions.py digest <path>` prints a readable timeline of it (prompts, replies, one line per tool call, errors) for anyone who needs the shape before the detail.

## 2. Spawn three reviewers in parallel

One message, three Agent calls: `general-purpose` agents playing the Reviewer role, in the background. They keep the session's MCP tools, which they need for context lookups (tickets, chat threads, traces the transcript references); their prompts tell them to write nothing.

| Lens | Prompt template |
|---|---|
| Judgment | [references/judgment-reviewer.md](references/judgment-reviewer.md) |
| Tooling | [references/tooling-reviewer.md](references/tooling-reviewer.md) |
| Divergent | [references/divergent-reviewer.md](references/divergent-reviewer.md) |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final message.

## 3. Synthesize

When all three have returned, one Agent call: a `general-purpose` Decider ([MODELS.md](../coordinator/MODELS.md); on its fallback when its model is unavailable, said in the reply), with [references/synthesizer.md](references/synthesizer.md) verbatim and each reviewer's full output inlined where marked. It spot-verifies citations and returns a structured Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, test, metadata flag, hook or runtime check, move it from Accepted to Backlog (Encode Lessons in Structure, `tstack:principles`).

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output to Luiz and wait for explicit approval. He picks the subset to apply and may redirect routings. Skill changes affect every future session: nothing is applied before his answer.

Skill edits land as **one jj change in the repo that owns the skill**, in a jj workspace of its own, never in a workspace another session uses. For tstack skills that repo is `~/repos/luizhcrocha/skills`:

```
cd ~/repos/luizhcrocha/skills; jj workspace add ../skills-reflect -r 'trunk()' --name reflect
```

(A workspace named `reflect` already there → `reflect-<date>`.) Then, for each approved Accepted item, follow its Routing:

- Trivial skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): make it directly.
- Substantive skill edit (a new section, a new table, more than ~10 lines), `tune description: <skill path>`, or `new skill: <kebab-name>`: write it under `tstack:writing-for-agents` (SKILL-MECHANICS.md for descriptions and invocation) and tuca-mode's Authoring a skill playbook. A new skill is registered the way the repo's `AGENTS.md` or `CLAUDE.md` says (plugin.json, the top-level and bucket READMEs).
- `memo <kind>`: a durable project fact, gotcha or decision that is not a skill edit becomes a memo note in the project it is about (`tstack:memo`).

In the tstack workspace, run `just test-changed` (the suites your change touches, `just validate` among them for prose), describe the change in the repo's style (`jj log` shows it; `tstack:unslop` for the words) naming what each edit fixes, then `jj new`. Never push or move a bookmark: the change is for Luiz to review, and landing it is his call or a Land run he asks for.

Backlog items do not wait for approval: each becomes a memo `open` note in the owning repo's workspace (the pattern, what was hit, the suggested mechanism, one line), so it ships inside the same change. An item whose mechanism is a lint rule then goes to `tstack:lint-evolve`, with the note's id as its evidence.

## 6. Summarize for Luiz

Short list, no preamble:

- Change: `<change id>` in `<workspace path>`, with the `just test-changed` result.
- Edits applied: `<skill path>`. What changed, one line each.
- New skills: `<skill path>`. One line each (rare).
- Memo notes: `<id>` `<kind>`, one line each, backlog `open` notes included.
- Dropped: one line per rejected finding and the synthesizer's reason.
