# Every note belongs to one of four scopes, and every scope travels on a `memo` bookmark

Status: Luiz decided the four scopes on 2026-11-16. The same day he decided that a repo's notes are committed on a `memo` bookmark of the repo's remote and not in its code history, and then that the machine, group and user notes are committed on the `memo` bookmark of the dotfiles' remote. The local copy, the exchange by file union and the moments of a sync are proposed in [docs/design/memo-v2](../design/memo-v2/design.md).

The single "global" store mixed facts about Luiz with facts about groups of repositories, and every session in every repository read all of it (8.7 KB). Every note now belongs to exactly one scope: repo, machine, group or user. A repo's notes are committed on a bookmark named `memo` of that repo's remote, in a history that shares no commit with the code. The remote backs them up and shares them, and they are in no working tree, diff, pull request or code search. Machine, group and user notes are committed on the `memo` bookmark of the remote of Luiz's dotfiles, beside the dotfiles' own notes. Luiz defines the groups in one file of the dotfiles, and a repository is in two groups at most. A session reads its repo, its machine, the groups that contain its repo, and the user scope.

On each machine, memo reads and writes every store in a local folder outside any checkout. It exchanges each store's files with its `memo` bookmark, through a git directory of its own. The exchange is a set union by file name. Every note, summary and retirement is its own file with a unique name and is never edited, so the union of two machines' files is always a valid store and no merge can conflict.

A fetch or a push needs Luiz's approval in 1Password, which no agent can give. So memo syncs only where a push that Luiz approves already happens: after a landing's push, inside the dotfiles' update command, or when he runs the sync himself. No hook syncs.

## Considered options

- **A repo's notes in its code history**, in `.tstack/memo/` of the working tree, as five of the six repositories have them today. Rejected by Luiz: the notes then appear in every diff, pull request and code search, and they are knowledge about the code, not part of it.
- **The checkout's own git directory, or a jj workspace, to reach the `memo` bookmark.** Rejected: a sync would then depend on the state of a checkout, run its hooks, and write to its jj operation log. A jj workspace of an agent has no `.git` at all.
- **The machine, group and user notes in a folder of the dotfiles on `nix`**, committed by the dotfiles' update command. This was Luiz's first placement. He replaced it: with the bookmark there is one way to exchange files, and no note file sits in a checkout.
- **Read and write the dotfiles checkout in place.** Rejected: another writer in that checkout can move its working copy and take uncommitted files off the disk. On 2026-11-06 an agent's `jj new nix@origin` did that to `flake.lock` during a build (`bin/entropic-update` in the dotfiles records it). A session in another repo would then read a smaller memory with no warning.
- **A jj workspace of the dotfiles that memo owns.** Rejected: the other machines hold the dotfiles as a plain git clone without jj (`bin/entropic-update`, "Two kinds of checkout"), so memo would need two publishing paths of its own.
- **One local store with a scope field on each note.** Rejected: a repo's notes must travel with the repo's remote to its other machines and its other readers.

## Consequences

- Nobody reviews a repository's notes with its code, because no change shows them.
- A note about a group that contains company repositories is stored on the remote of Luiz's dotfiles. A group or user note must not name a client, a case or case material.
- A note written on one machine reaches the others when both machines have synced: after a landing, or after the dotfiles update.
- A repository with no remote keeps its notes on one machine, with no backup.
- Removing a note for good (a leaked secret) is a manual act on every machine and in the history of the bookmark. memo itself never deletes.
