---
name: fork-tab
description: "Hand a new idea this session drifted onto to a fresh agent in a Rex tab next to this one, under tuca-mode, with its edits moved to its own jj workspace, then go back to the work it interrupted. Use for /fork-tab, \"fork this to a tab\", or when the session has wandered off its task onto a new thread."
argument-hint: "[the new idea, in a few words]"
---

# fork-tab

A session works on A. A new idea, B, comes up, and the session starts on B and leaves A behind. fork-tab gives B to a fresh agent in a tab beside this one, and this session goes back to A.

Use spin-off instead when B needs its own design and team. fork-tab is for a thread one agent can carry: no proposal, no designer, no gates.

Luiz invoking the skill is the yes. Do not ask whether to fork.

## 1. Name B

- If Luiz passed an argument, it names B. If not, B is the thread the session drifted onto most recently.
- Choose a slug: 2 to 4 words in kebab-case that name the work, not the tool, for example `memo-dedupe`. Use lower-case letters, digits and `-`. The tab, the Claude Code session, the workspace and the handoff file all take this slug.
- When you cannot tell A from B in the conversation, ask with `AskUserQuestion`, naming the threads you see.

Done when you have the slug, one sentence for A and one for B.

## 2. Move B's edits to their own workspace

Two agents never share one jj workspace, so B gets its own workspace, based where A is based:

```sh
jj workspace add ../<repo>-<slug> -r @- --name <slug>
```

When B has touched files, move those files out of `@` into the new workspace's change:

```sh
jj squash --from @ --into <slug>@ <B's paths>
```

- A file that both A and B edited stays in `@`. Name it in the handoff under `mixed`, so the new agent rewrites B's part of it.
- If B has no edits yet, skip the squash.
- If `jj workspace add` fails because the name is taken, append `-2`.

Done when `jj diff --summary` in `@` shows only A's files and `jj diff --summary -r <slug>@` shows only B's.

## 3. Write the handoff

Write `$TMPDIR/fork-tab-<slug>.md` (`/tmp` when `$TMPDIR` is unset). Keep it outside the repo so it never lands in a change. Use one section for each of these:

- `goal`: B in one sentence, and the next step.
- `where`: the workspace path, its change id, and the repo's landing bookmark.
- `so-far`: decisions made with Luiz and why, what was tried, and what failed.
- `evidence`: `file:line` pointers, commands and their output, URLs.
- `mixed`: files left in A's change that B also needs, or `none`.
- `not-yours`: A, in one sentence, so the new agent leaves it alone.
- `skills`: the skills the new agent should load, such as `tstack:tdd` or `tstack:lang-ts`.

Point at files. Do not paste anything a path can carry. Remove secrets.

Done when every section has content or says `none`.

## 4. Open the tab beside this one

This step needs Rex (`REX_SESSION` and `REX_BLOCK` set). Open the tab in this Rex session without focusing it, then move it to the right of your own tab:

```bash
me=$(rex whoami --json | jq -r .window_id)
new=$(rex window new -s "$REX_SESSION" <slug> -c ../<repo>-<slug> --focus=false --json \
  -- claude --name <slug> --model opus --effort high \
  "/tstack:tuca-mode Continue the work in <handoff file>. Run jj workspace update-stale first, then load the skills it lists." \
  | jq -r .window_id)
rex window move -s "$REX_SESSION" "$new" --after "$me"
```

Opus high is the Implementer row of [models.md](../../../docs/models.md). If Luiz names a model, use his.

Outside Rex, give Luiz the launch in nushell instead: `cd ../<repo>-<slug>; claude --name <slug> --model opus --effort high "/tstack:tuca-mode Continue the work in <handoff file>. Run jj workspace update-stale first, then load the skills it lists."`

Done when `rex window ls -s "$REX_SESSION"` lists `<slug>` right after your tab, or Luiz has the command.

## 5. Go back to A

Reply in three lines:

1. The tab and the handoff file.
2. The files that moved, and any that stayed under `mixed`.
3. A's next step.

Then continue with A.
