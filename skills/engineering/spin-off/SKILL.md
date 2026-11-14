---
name: spin-off
description: "Hand complex work found mid-session, outside your task, to a designer in its own Rex session, then go back to your task. Use when such work turns up, or on \"spin this off\"."
---

# Spin-off

Work found mid-session that lies outside your task and is too big to fold into it leaves to a designer in its own Rex session, named after the work. The designer researches and models it until Luiz approves a design, a lane plan and a team, then starts the coordinators.

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
3. **Open the designer's session.** Inside Rex (`$REX_SESSION` is set), create a Rex session labelled `<slug>`, with the designer in it:

   ```sh
   rex new <slug> -c <repo> -- claude --name designer-<slug> --model opus --effort high "/tstack:tuca-mode /tstack:designer <spin-off file>"
   ```

   The pair is the Designer row of [models.md](../../../docs/models.md). Outside Rex, give Luiz the launch in nushell instead: `cd <repo>; claude --name designer-<slug> --model opus --effort high "/tstack:tuca-mode /tstack:designer <spin-off file>"`. Done when `rex ls` lists `<slug>` or Luiz has the command.
4. **Return to your task.** You never wait on the designer. It posts to `fleet news` when the coordinators start. Your reply names the spin-off file and the Rex session `<slug>`.
