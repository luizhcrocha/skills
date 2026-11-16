# Decisions

No decision is open. This file has four parts: what Luiz decided on 2026-11-16, what the design still asks of him, what the second revision changed on the advisor's review without his word, and the defaults that nobody questioned. The design files describe the decided options.

## Decided by Luiz, 2026-11-16

### 1. A summary quotes notes, and its count line names what it hides

[ADR 0007](../../adr/0007-summaries-quote-notes.md) stands. A summary keeps notes word for word and never rewrites them. Luiz added one thing. The count line of a summary prints the most distinctive words of the notes it hides, as in `(+11 notes, 2026-09-16..10-08, about deploy, R2, narinfo: memo zoom BFKX9K)`. memo takes the words from the index, with no model, so the line can print only words that the hidden notes contain. The rule for the words is in [design.md](design.md#the-count-line).

Two checks support the decision. Today's summaries, written by session models, invent in 8 of 30 cases ([faithfulness](evidence/faithfulness-2026-11-16.md)). With Haiku compressing, a rewritten line states something false in 5 of 30 cases at level 1 and in 5 of 8 at level 2, and quoted notes in none ([compress](evidence/compress-2026-11-16.md)). The same test gives the price. A rewritten line carries 4.4 of a group's 8 main facts in 277 bytes, and three quoted notes carry 2.9 in 654 bytes.

### 2. Two groups: tooling and company

| Group | Repositories |
| :-- | :-- |
| `tooling` | luizhcrocha/skills, luizhcrocha/fleet, luizhcrocha/dotfiles |
| `company` | coelhorocha/custom-mcp-servers, coelhorocha/durable-automations, coelhorocha/chimr |

The file is in [design.md](design.md#groups). Each repository is in one group, so each reads one group in a slice of 2,500 bytes, about 8 notes.

### 3. A repository's notes live on a `memo` bookmark of its remote

The notes are not in the code history. They are not in the working tree, so they are in no diff, no pull request and no code search. The remote backs them up and shares them on a bookmark named `memo`. memo keeps a local copy in its home folder and syncs the bookmark. The sync is in [design.md](design.md#every-store-travels-on-a-memo-bookmark), and [ADR 0005](../../adr/0005-notes-belong-to-one-of-four-scopes.md) records the decision.

This decision ends the old question of whether custom-mcp-servers commits its store. That repository keeps `.tstack/` out of its code history, as today.

### 4. The quote tree stays 12 wide

A summary covers up to 12 items and keeps up to a quarter of them. The advisor proposed a smaller group and withdrew the proposal.

### 5. custom-mcp-servers starts fresh

The store of custom-mcp-servers holds 4,101 notes, 3,934 of them live. They exist on one machine and were never committed. They become a local archive: `memo recall` finds them, and no start read shows them. The repository's new store holds the notes written from the cutover on, and the notes that step 3 of the migration writes from its open threads and pins.

The option not taken was first picks: about 600 compaction tasks to choose what to keep, after which the old notes would go to the company remote. The old notes were written under the old rules, at 117 a day, and one in ten is status. The cost of starting fresh is that a decision from October reaches a session only when the session searches for it, and that the archive is on one machine.

### 6. memo v2 switches at once, and nothing in the switch is work for Luiz

His words: "this should be autonomous, not action by my side because i don't want to loose time maintaining notes".

memo v2 stops holding unfinished work, and it does not wait for `fleet waiting` to list paused designers. The 96 open threads and 16 pins of the old stores get no triage page. An agent pass gives each one an end: a plain knowledge note in the right scope, a line in its owner's record (a fleet's ledger or a designer's dossier), or a retirement with a reason. What the pass cannot place is retired as "unplaced" and listed in a report file. The pass opens no card and asks no question ([migration.md](migration.md), step 3).

The cost is stated in the migration: a thread retired as "unplaced" may still have mattered, and nobody is told. It stays searchable. Until the fleet repo adds the designers' list, a paused designer's questions are visible in its dossier and its Rex tab only.

The same rule now holds for the whole design. [What still needs Luiz](#what-still-needs-luiz) is the audit.

### 7. The machine, group and user stores move to the dotfiles' `memo` bookmark

They travel on the `memo` bookmark of the dotfiles' remote, beside the dotfiles' own notes, as the folders `user/`, `machine/<name>/` and `group/<name>/`. The sync is the one that repo stores use. The folder `memo/` on `nix` and the `commit_paths` line in `entropic-update` are gone, and `entropic-update` keeps one step, `memo sync --all`. `groups.toml` stays a file on `nix`, because it is configuration and home-manager installs it.

This replaces Luiz's earlier placement of these stores on `nix`. memo now has one way to exchange files, and no note file sits in a checkout that another writer can move.

## What still needs Luiz

The audit that decision 6 asked for. Each row is a step of the second revision that put something in front of Luiz, or could have.

| Step | Before | Now |
| :-- | :-- | :-- |
| The open threads and pins | A triage page of 96 threads and 16 pins, with rows for him to answer and AGENTS.md lines to approve | The agent pass of decision 6. No page, no card, no proposal |
| Re-filing the global store | He read the whole list of notes for the user scope | A Researcher places each note, a Decider the unsure ones. In doubt the narrower scope wins. What nobody can place is retired as "unplaced" |
| `groups.toml` | He edited a draft | The migration writes the file with the two groups he chose. Nothing asks for an edit |
| The first sync of each repository | He ran `memo sync` six times and approved each push | The first landing in a repository, or the next `entropic-update`, creates the bookmark |
| `memo doctor` | Findings with nobody named to act | No finding is addressed to him. Each clears by itself or is a fact for the session that asked: notes that wait leave at the next sync, a missing `memo.toml` arrives with the next rebuild, a store over its slice clears by tasks, a summary not in effect costs nothing |
| Lines in the start read about waiting or unfetched notes | A session read them and could only pass them on to him | Removed from the start read. `memo doctor` keeps the counts |
| `memo retire` and `memo supersede` | Sessions | Sessions, as before. He never runs them |
| Look-alike advice | Printed to the writing session | The same. Advice that a session ignores costs him nothing: `memo recall` folds the repeat, and the next pick leaves it out |
| Compaction tasks and first picks | Sessions and Researchers | The same |
| The measures at the cutover and at day 14 | No owner named | The fleet that builds memo v2 runs them and writes each result to a file. A result that calls for a change becomes code work in that fleet |

Four things cannot be autonomous, and the reasons are these.

- **A fetch or a push needs his approval in 1Password.** The SSH key is his, and no agent can approve its use. The design asks for no approval beyond those he gives today: the push of a landing, and `entropic-update`. One point is unchecked: whether the approval of a landing push also covers memo's push a moment later. If it asks for a second click, the sync leaves the land playbook and notes travel with `entropic-update` only.
- **Defining a group.** Which repositories work together is his knowledge. Nothing waits on it: a repository in no group reads no group, and nothing reminds him.
- **Removing a note for good, after a leaked secret.** It rewrites a bookmark's history, and a forced push is on tstack's pause list. memo refuses a line that matches a secret pattern, so the case should be rare.
- **Renaming a repository on its remote.** The repository's key changes, and `groups.toml` names the old one until he edits it. Until then the repository reads no group. memo cannot tell that two names are one repository.

## Changed on the advisor's review

These are not Luiz's calls. The advisor reviewed the first revision, and the second revision took each point. Luiz can reverse any of them.

| Point | What the design does now | Why |
| :-- | :-- | :-- |
| A store over its slice | The oldest notes outside a summary leave the read first. A note that a summary keeps stays ([design.md](design.md#what-a-section-shows)) | The first revision dropped the oldest lines, which are the chosen notes. A burst of writes would have hidden them |
| A stale kept note | A task over summaries tells the session to retire or supersede a kept note that a later note contradicts | It was the only fault of quoted notes in the test: 1 of 30 at level 1, 2 of 8 at level 2 |
| Record files in subfolders | `notes/<first 4 characters of the ULID>/`, one folder for 12.4 days | A commit that adds one note to a flat folder of 42,000 writes 1.94 MB of tree objects, against 0.07 MB with subfolders |
| `groups.toml` | memo reads the copy that home-manager installs, never the file in the dotfiles checkout | Another writer can move that checkout to a commit with an older file |
| The machine's name | It comes from `memo.toml` only. Without the file there is no machine scope, and the start read says so | The Mac's host name differs from its name in the flake. A silent fallback would make a second store |
| A machine without memo | `entropic-update` skips the memo step and says so | A new machine runs the update before tstack is installed |
| A note about another repository | `memo note --scope repo:<owner>/<name>`, for a repository that has a store on this machine. Otherwise the group | The first revision gave such a note no home |
| Groups for one repository | Two at most | One note of 280 characters with its heading needs about 425 bytes, and the groups share 2,500 |
| Reporting commands | `memo doctor` prints what `memo stats` and `memo scopes` printed. Those two commands are gone | One command to learn |
| The nightly check | Gone. memo-dream is deleted, and its checks run in `memo doctor` on demand | A report that nobody owns is a new kind of open thread |
| The budget split | Five constants in the code: 600, 3,000, 1,900, 2,500 and 6,000 bytes. No `[budget]` in a config file | Nobody asked to tune it, and a setting needs tests |
| Session start time | memo lists file names and parses only new files. The target is in [measures.md](measures.md) | Measured on 4,101 notes: 1.5 ms for the names, 12 ms for a stat of each file, 45 ms to read each file |
| Recall at scale | `memo recall` folds look-alikes, and a measure counts them in the first results | Look-alike pairs fill the first results with one fact |

## Defaults that nobody questioned

The first revision put these to Luiz as decisions. Neither he nor the advisor changed the recommended option, so the design keeps it. Each is cheap to change later.

| Default | The option kept | The other option |
| :-- | :-- | :-- |
| A look-alike at write time | `memo note` writes the note, then prints the look-alike and the two commands that fix a repeat or a correction | Refuse the write until the session passes `--despite ID`. Change to this if look-alike pairs stay over 1 for every 100 new notes after two weeks |
| First picks for the small stores | Researchers answer the tasks of every store except custom-mcp-servers, about 250 tasks in all | No picks: each store shows its newest notes and a count line, and the backlog clears one task per write |
| Numbers | 280 characters a note, a quarter of a group kept, the newest quarter of a slice never offered, word overlap of 0.5 for a look-alike, 3 words in a count line, 20 seconds for a fetch or a push | Each is one constant |
