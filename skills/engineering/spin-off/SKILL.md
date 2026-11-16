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
   - `goal`: one sentence, what changes for whom.
   - `found-in`: this session's name, the repo's path, your jj change id.
   - `evidence`: file:line pointers, logs, what was tried.
   - `constraints`: the known musts and must-nots.
   - `out-of-scope`: what you keep doing yourself.

   Point at files; paste nothing a path can carry. The file is read-only once the designer opens. Done when every section has content or says `none`.
3. **Open the designer's tab**: label `designer-<slug>`, Rex session `designers`, folder `<repo>`, the Designer row of [models.md](../../../docs/models.md), opening `/tstack:tuca-mode /tstack:designer <spin-off file>`. `<model>` and `<effort>` below are that row's pair. Inside Rex (`$REX_SESSION` is set), when `rex ls` lists `<session>`:

   ```sh
   rex window new -s <session> <label> -c <folder> --focus=false -- claude --name <label> --model <model> --effort <effort> "<opening>"
   ```

   When it does not, create the session with the tab in it:

   ```sh
   rex new <session> -c <folder> --window <label> -- claude --name <label> --model <model> --effort <effort> "<opening>"
   ```

   Outside Rex, give Luiz the launch in nushell instead: `cd <folder>; claude --name <label> --model <model> --effort <effort> "<opening>"`. Done when `rex window ls -s <session>` lists `<label>` or Luiz has the command.
4. **Return to your task.** You never wait on the designer. Your reply names the spin-off file and the tab `designer-<slug>` in the session `designers`.
