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
   - `split`, only when the work is one part of a larger effort split across designers: the split's name, lower-case letters, digits and `-`.

   Point at files; paste nothing a path can carry. The file is read-only once the designer opens. Done when every section has content or says `none`.

   Decide a split with Luiz before any file: the parts and the split's name. Each part gets its own spin-off file, with its own `<slug>` and the same `split`, and steps 2 and 3 run once per part. Each designer stops after its plan, and the [council](../council/SKILL.md) launches the split once every designer of it has stopped.
3. **Open the designer's tab.** Inside Rex (`$REX_SESSION` is set), open a tab labelled `designer-<slug>` in the Rex session `designers`. When `rex ls` lists `designers`:

   ```sh
   rex window new -s designers designer-<slug> -c <repo> --focus=false -- claude --name designer-<slug> --model opus --effort high "/tstack:tuca-mode /tstack:designer <spin-off file>"
   ```

   When it does not, create the session with the tab in it:

   ```sh
   rex new designers -c <repo> --window designer-<slug> -- claude --name designer-<slug> --model opus --effort high "/tstack:tuca-mode /tstack:designer <spin-off file>"
   ```

   The pair is the Designer row of [models.md](../../../docs/models.md). Outside Rex, give Luiz the launch in nushell instead: `cd <repo>; claude --name designer-<slug> --model opus --effort high "/tstack:tuca-mode /tstack:designer <spin-off file>"`. Done when `rex window ls -s designers` lists `designer-<slug>` or Luiz has the command, for every part of a split.
4. **Return to your task.** You never wait on the designer. It posts to `fleet news` when the coordinators start. Your reply names each spin-off file, each tab `designer-<slug>` in the session `designers`, and the split's name when there is one.
