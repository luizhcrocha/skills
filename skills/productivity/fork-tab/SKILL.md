---
name: fork-tab
description: "Fork an idea the session drifted onto to a fresh tuca-mode agent in its own Rex tab and jj workspace, or work that needs a design first to a designer, then resume. Use for /fork-tab, off-task drift, or \"spin this off\"."
argument-hint: "[the new idea, in a few words]"
---

# fork-tab

A session works on A. A new idea, B, comes up, and the session starts on B and leaves A behind. fork-tab gives B to a fresh agent in a tab beside this one, and this session goes back to A.

Luiz invoking the skill is the yes. Do not ask whether to fork.

**Needs a design.** When B is outside your task and needs a design Luiz approves before anyone builds it (several pieces, a choice only he holds), offer it in one line of your reply; "spin this off" is the yes. The handoff then carries the problem, not a solution: `goal` is the outcome for whoever is affected, never a decision to make; `evidence` is measured (what failed, where and when, logs and `file:line`, what was tried); `so-far` quotes Luiz's words. The tab runs `/tstack:designer <handoff file>` in place of tuca-mode, on the Designer row of [models.md](../../../docs/models.md). Work this session will do itself is `tstack:figure-it-out`'s.

## 1. Name B

- If Luiz passed an argument, it names B. If not, B is the thread the session drifted onto most recently.
- Choose a slug: 2 to 4 words in kebab-case that name the work, not the tool, for example `memo-dedupe`. Use lower-case letters, digits and `-`. The tab, the Claude Code session, the workspace and the handoff file all take this slug.
- When you cannot tell A from B in the conversation, ask Luiz, naming the threads you see.

Done when you have the slug, one sentence for A and one for B.

## 2. Move B's edits to their own workspace

Two agents never share one jj workspace, so B gets its own workspace, based where A is based:

```sh
ws=$(ws-add <slug> -r @-)   # <repos>/.ws/<repo>/<slug>
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
- `where`: the workspace path, its full change id (`jj log -r <slug>@ -T change_id`), and the repo's landing bookmark. Other pieces wait on that change, so B's work lands in it: squash into it, never abandon or re-create it, or a wait on it gets no answer.
- `so-far`: decisions made with Luiz and why, what was tried, and what failed.
- `evidence`: `file:line` pointers, commands and their output, URLs.
- `mixed`: files left in A's change that B also needs, or `none`.
- `not-yours`: A, in one sentence, so the new agent leaves it alone.
- `skills`: the skills the new agent should load, such as `tstack:tdd` or `tstack:lang-ts`.
- `end`: when B is done (landed, or answered): tell the session that forked you, `fleet msg note <this session's name> "<slug>: done, <one line>"`; then `fleet suspend me --why "<slug> done"`. Leave your workspace: you run inside it, so `ws-rm` refuses it, and fleet removes it when it ends you (the prune sweep until then). Luiz starting the fork is his yes to both, so do them unasked. The broker refuses a note to a forker that is suspended or ended (exit 1, `refused: suspended` or `no-session`, nothing stored): then ask Luiz where the result goes (`fleet msg decide --question "<slug> is done (<one line>); <forker> is <its refusal>. Who gets the result?"`), send it there once he answers, and only then suspend; never suspend with that question open (Luiz, 2026-11-21: "notes refused. agents should check before sending, and ask where to send it instead").
- `waits`, optional, when B starts only after other pieces land: one `fleet msg wait landed <full change id>` per piece, B's first step, the id copied from that piece's `where`. It returns at once for a change already landed. A short id stops resolving once the change is hidden, so write the full 32 letters, and open B only once each piece it waits on has been opened and has its id.
- `next`, optional, when B is one piece of several: "after you land, open the next piece with fork-tab from <its handoff file>". A piece that waits on two is named in one of their `next` lines, and its `waits` holds it until the other lands.

Point at files. Do not paste anything a path can carry. Remove secrets.

Done when every section has content or says `none`.

## 4. Open the tab beside this one

This step needs Rex (`REX_SESSION` and `REX_BLOCK` set). Open the tab in this Rex session without focusing it, then move it to the right of your own tab:

```bash
me=$(rex whoami --json | jq -r .window_id)
new=$(rex window new -s "$REX_SESSION" <slug> -c "$ws" --focus=false --json \
  -- claude --name <slug> --model opus --effort high \
  "/tstack:tuca-mode Continue the work in <handoff file>. Run jj workspace update-stale first, then load the skills it lists." \
  | jq -r .window_id)
rex window move -s "$REX_SESSION" "$new" --after "$me"
```

Opus high is the Implementer row of [models.md](../../../docs/models.md); a design takes the Designer row and opens with `/tstack:designer <handoff file>`. If Luiz names a model, use his.

Outside Rex, give Luiz the launch in nushell instead: `cd <the path ws-add printed>; claude --name <slug> --model opus --effort high "/tstack:tuca-mode Continue the work in <handoff file>. Run jj workspace update-stale first, then load the skills it lists."`

Done when `rex window ls -s "$REX_SESSION"` lists `<slug>` right after your tab, or Luiz has the command.

## 5. Go back to A

Reply in three lines:

1. The tab and the handoff file.
2. The files that moved, and any that stayed under `mixed`.
3. A's next step.

Then continue with A.
