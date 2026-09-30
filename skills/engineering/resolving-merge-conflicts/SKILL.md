---
name: resolving-merge-conflicts
description: "Resolve merge conflicts by intent: jj changes left conflicted by a rebase, squash or workspace update, or an in-progress git merge/rebase. Use when `jj log` marks a change (conflict), a rebase reports new conflicts, or git stops mid-merge."
---

In jj a conflict is recorded in the commit. A rebase always finishes; the conflicted changes carry the conflict until someone resolves it, and their descendants rebase on top of it. Nothing is mid-rebase, so there is nothing to continue or abort. In a plain git repo (no `.jj`), see [Git fallback](#git-fallback).

1. **See the state.** `jj log -r 'conflicts()'` lists the conflicted changes; `jj resolve --list -r <rev>` names each one's files; `jj op log -n 5` shows the operation that caused it. Work bottom-up: resolving the lowest conflicted change often clears its descendants. Done when you have the list of changes and files.

2. **Read both sides and their intent.** `jj file show -r <rev> <path>` prints the file with jj's markers, each side labelled with its change id, subject and role: for a rebase, the parents of the rebased revision (the base), the rebase destination, and the rebased revision. A `%%%%%%%` section is a diff from the base to one side; a `+++++++` section is the other side's snapshot. For each side, find why it changed:
   - the rebased change's own intent: `jj evolog -r <rev>` names its pre-rebase commit, and `jj show <that commit>` is the change as its author wrote it;
   - the destination's: `jj log -r '::<rev>- & files(root:"<path>")' --limit 5`, then `jj show` on each change that touched the hunk;
   - their PRs and tickets: `gh pr list --search <commit id> --state all` (from the main workspace; a secondary jj workspace has no `.git`), then `gh pr view <n>`.

   When a side's intent is still unclear, run `tstack:why` on the hunk before guessing. Done when each hunk's two intents are written down in one line each.

3. **Resolve each hunk by intent.** Work in a child of the conflicted change: `jj new <rev>`, then edit the files, removing every marker line. Preserve both intents where they are compatible. Where they are not, keep the side that matches the operation's goal (for a rebase, the destination's behaviour with the rebased change's intent reapplied on top) and note the trade-off. Never invent behaviour neither side had. `jj diff` shows the resolution; read it. Then `jj squash --use-destination-message` moves it into the conflicted change, keeping that change's description (without the flag, jj may open an editor to merge descriptions and a headless run hangs), and its descendants rebase onto the resolution. Done when `jj resolve --list -r <rev>` reports no conflicts and `jj log -r 'conflicts()'` no longer lists `<rev>`.

   Repeat for the next conflicted change up the stack. Resolving in place (`@` is the conflicted change, no child) is fine for a single-file fix; the child keeps a larger resolution reviewable before it lands in the change.

4. **Run the repo's checks** on the resolved stack, as the repo names them (the justfile, package scripts, the CI config): typecheck, then tests, then format. A failure the resolution caused is fixed in the conflicted change (`jj squash --into <rev>` or `jj absorb`), then the checks run again. Done when they pass, or a failure is shown to predate the conflict.

5. **Report** each file: the two intents, what you kept, the trade-off when one side lost, the sources you read, and the check results. `jj op restore <op before step 3>` undoes the resolution.

## Git fallback

In a git repo without jj, the operation stops mid-way instead:

1. `git status` shows the merge or rebase in progress and the conflicted files; `git log --merge` and `git log -1 <MERGE_HEAD|REBASE_HEAD>` show the sides.
2. Find each side's intent from its commit message, PR and ticket, as in step 2 (`git log -- <path>`, `git show <commit>`).
3. Resolve each hunk by intent, as in step 3. Always resolve; never `--abort`.
4. Run the checks, as in step 4.
5. `git add` the resolved files, then `git commit` (merge) or `git rebase --continue`, and repeat until every commit is rebased.
