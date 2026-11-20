# Luiz Rocha Skills

A collection of agent skills (slash commands and behaviors) loaded by Claude Code. Skills are organized into buckets and consumed by per-repo configuration emitted by `/setup-luizrocha-skills`.

Based on [mattpocock/skills](https://github.com/mattpocock/skills#)

## Language

**Issue tracker**:
The tool that hosts a repo's issues — GitHub Issues, Linear, a local `.scratch/` markdown convention, or similar. Skills like `to-issues`, `to-spec`, and `triage` read from and write to it.
_Avoid_: backlog manager, backlog backend, issue host

**Issue**:
A single tracked unit of work inside an **Issue tracker** — a bug, task, spec, or slice produced by `to-issues`.
_Avoid_: ticket (use only when quoting external systems that call them tickets)

**Triage role**:
A canonical state-machine label applied to an **Issue** during triage (e.g. `needs-triage`, `ready-for-afk`). Each role maps to a real label string in the **Issue tracker** via `docs/agents/triage-labels.md`.

**Link kind**:
What a **Link** is to the user: preview, prototype, doc, tool or service; an old `dev` or `page` row is read as one when shown.
_Avoid_: link type

**Reach**:
Where a **Link** answers from: `machine` (this machine or its tailnet, probed), `external` (never probed) or `file`.

**Files root**:
The directory the hub serves a fleet's `file://` **Links** from: the fleet's DIR, or its session's scratchpad or state dir.

**Standing approval**:
A kind of act the user approved once, with a plain yes on the page (K1); acts under it are recorded as notices, not asked.

**Frozen twin**:
The Python fleet (`skills/productivity/coordinator/scripts/*.py` in the fleet repo's plugin): bug fixes only, until it is deleted.

### Memory

**Knowledge**:
What a session learned that will still be true in a month and is not already in code, docs, commits or a plan. Knowledge is the only thing memo holds.
_Avoid_: lesson, memory, observation

**Note**:
One line of **Knowledge**, at most 280 characters, that a session wrote on purpose. A note belongs to exactly one **Scope** and is never edited.
_Avoid_: memory, observation, entry

**Admission rule**:
The two questions a line must pass to become a **Note**: will it still be true in a month, and is it absent from code, docs, commits and plans?

**Work item**:
Something unfinished: a thread, a question, or a task that waits on someone. A work item lives with its **Owner**, never in memo.
_Avoid_: open thread, open note, todo

**Owner**:
The record that holds a **Work item** until it is done: a handoff, a `fleet msg` thread, or an **Issue**.

**History**:
What happened in a session, turn by turn. tape records history; memo does not.
_Avoid_: narration, status note

**Scope**:
The set of sessions a **Note** is true for. There are four kinds: **Repo scope**, **Machine scope**, **Group scope** and **User scope**.
_Avoid_: project (for a scope), global

**Repo scope**:
True for one repository on any machine.
_Avoid_: project scope

**Machine scope**:
True for one computer in any repository.

**Group scope**:
True for the repositories of one **Group**.

**User scope**:
True about Luiz in every repository on every machine.
_Avoid_: global scope

**Group**:
A named set of repositories that work together, defined by Luiz. A repository is in two groups at most.

**Store**:
The **Notes**, **Summaries** and **Retirements** of one **Scope**: one repository's, one machine's, one group's, or the user's.

**Memo bookmark**:
The bookmark named `memo` on a remote. A repository's memo bookmark carries its **Store**, in a history apart from the code. The memo bookmark of the dotfiles also carries the machine, group and user stores.
_Avoid_: memo branch, notes branch

**Sync**:
To exchange a **Store**'s records with its copy elsewhere, by union of file names. A sync adds records on both sides and removes none.
_Avoid_: publish, push (for notes)

**Live note**:
A **Note** that no later note supersedes and no **Retirement** names.

**Supersede**:
To replace a wrong **Note** with a new note that states the truth. The old note stays in the **Store** for **Recall**.
_Avoid_: edit, update, close

**Retirement**:
A record that takes a **Note** or a **Summary** out of the **Start read** without a replacement, with the reason.
_Avoid_: delete, close

**Summary**:
A record that stands for a group of older **Notes** in the **Start read**. It names the few notes of the group to keep reading, word for word, and counts the others. It never rewrites a note.
_Avoid_: digest, compaction line

**Kept note**:
A **Note** that a **Summary** keeps in the **Start read**.

**Count line**:
The line of the **Start read** that stands for the notes a **Summary** does not keep. It gives their number, their dates and their most distinctive words.

**Compaction task**:
The request memo prints after a write when a **Store** is over its **Slice**: from the oldest group of notes, name the ones to keep.

**Start read**:
The text a session reads when it starts: for each **Scope** the session belongs to, the newest **Live notes** and the **Kept notes**, within the **Budget**.
_Avoid_: wake, brief

**Budget**:
The size limit of the **Start read**, in bytes. The budget limits what a session reads, never what a **Store** holds.

**Slice**:
The part of the **Budget** that one **Scope** gets.

**Recall**:
A search over every **Note** of every **Store** the machine holds, live or not.

**Zoom**:
To open a **Summary** into the notes and summaries it stands for.

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- A **Note** belongs to exactly one **Scope**, and a **Store** holds the notes of one scope
- A session reads the **Repo scope** of its repository, the **Machine scope** of its computer, the **Group scope** of every **Group** that contains its repository, and the **User scope**
- A **Group** contains one or more repositories, and a repository is in zero, one or two groups
- Every **Store** travels on a **Memo bookmark**, never in a code history
- A **Summary** stands for notes or lower summaries of one **Store**, and keeps zero or more of those notes
- A **Work item** has one **Owner**, and that owner is never memo
- The **Budget** is the sum of the **Slices** and of the header of the **Start read**

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
- "open thread" was a kind of memo note for unfinished work. Resolved: unfinished work is a **Work item** with an **Owner**, and memo holds only **Knowledge**.
- "global" meant both facts about Luiz and facts about several repositories. Resolved: **User scope** and **Group scope** are separate, and "global" is no longer a scope.
- "wake" and "brief" named the text read at session start, with and without a size limit. Resolved: the text is the **Start read**, and it always has a **Budget**.
- "committed in the repo" meant in the repository's code history. Resolved: a repository's **Notes** are committed on its **Memo bookmark**, and no working tree holds them.
- "summary" meant a rewritten line in memo and in tape. Resolved for memo: a **Summary** quotes **Notes** and never rewrites them. tape's summaries are tape's own term.
