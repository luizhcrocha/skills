---
name: spin-off
description: "Hand complex work found mid-session, outside your task, to a designer in Rex's `designers` session, then go back to your task. Use when such work turns up, or on \"spin this off\"."
---

# Spin-off

Work found mid-session that lies outside your task and is too big to fold into it leaves to a designer, a tab in the Rex session `designers` that holds every designer. The designer (`tstack:designer`) owns the work from there.

Work this session will do, however large, is `tstack:figure-it-out`'s. Work that should leave to its own team is a spin-off.

## Steps

1. **Propose.** Ask Luiz with `AskUserQuestion`: the work in one sentence, why it is outside your task, and the choice to spin it off or leave it. "Spin this off" from Luiz is the yes, so skip the question. A fleet worker or a subagent reports the proposal to its parent and stops here. Done when Luiz has answered; on a no, go back to your task.
2. **Write the spin-off file** at `$TMPDIR/spin-off-<slug>.md` (`/tmp` when `$TMPDIR` is unset), outside the repo, so it never lands in your open change. `<slug>` is lower-case letters, digits and `-`. One section each:
   - `goal`: one sentence, the outcome for whoever is affected, such as "lawyers never read stale case data without knowing it". Never a decision to make, such as "decide what replaces X".
   - `found-in`: this session's name, the repo's path, your jj change id.
   - `evidence`: the failures you observed: what happened, where and when, measured, with paths to the logs, recordings and code (file:line) that show it, and what was tried. A list of directories is not evidence.
   - `constraints`: Luiz's words, quoted, and the facts any design must survive. Never the solution or a direction to confirm.
   - `out-of-scope`: what you keep doing yourself.
   - `waits-for`: the slug of the designer this one opens after, or `none`.

   The file carries the problem; the designer owns the model. It never splits the work into lanes, owners or seams: a redesign of one system is one spin-off. Point at files; paste nothing a path can carry. The file is read-only once the designer opens. Done when every section has content or says `none`.
3. **One architecture, one designer at a time.** Several spin-offs that share one architecture, a context file or seams between them open in order: only the designer for the spin-off the others build on opens now, and each other file names it in `waits-for`. That designer opens them after its gate 1, so each reads an approved model instead of guessing its neighbours'. Luiz may ask for them all at once, in his own words. Done when every file but one says `none` or names an earlier slug, or Luiz asked for all at once.
4. **Open the designer's tab** for each file whose `waits-for` is `none`: label `<slug>-designer`, Rex session `designers`, folder `<repo>`, the Designer row of [models.md](../../../docs/models.md), opening `/tstack:tuca-mode /tstack:designer <spin-off file>`. `<model>` and `<effort>` below are that row's pair. Inside Rex (`$REX_SESSION` is set), when `rex ls` lists `<session>`:

   ```sh
   rex window new -s <session> <label> -c <folder> --focus=false -- claude --name <label> --model <model> --effort <effort> "<opening>"
   ```

   When it does not, create the session with the tab in it:

   ```sh
   rex new <session> -c <folder> --window <label> -- claude --name <label> --model <model> --effort <effort> "<opening>"
   ```

   Outside Rex, give Luiz the launch in nushell instead: `cd <folder>; claude --name <label> --model <model> --effort <effort> "<opening>"`. Done when `rex window ls -s <session>` lists `<label>` or Luiz has the command.
5. **Return to your task.** You never wait on the designer. Your reply names the spin-off files, the tabs opened in the session `designers`, and which files wait on which.
