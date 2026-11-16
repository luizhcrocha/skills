# Migration

How the existing stores become v2 stores. Agents run every step, and no step waits for Luiz or puts a page, a card or a question in front of him. He decided that on 2026-11-16: "this should be autonomous, not action by my side because i don't want to loose time maintaining notes". The numbers were measured on 2026-11-16.

## What exists

| Store | Notes | Live | Summaries | Open threads | Pins | Under version control |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| custom-mcp-servers | 4,100 | 3,933 | 259 (244 at level 1, 15 at level 2) | 49 | 11 | No. `.tstack/` is in `.gitignore` |
| skills | 133 | 113 | 1 | 6 | 0 | Yes, in the code history |
| global | 278 | 254 | 49 (45 at level 1, 4 at level 2) | 7 | 3 | No. It is a local folder |

In these three stores, 62 open threads and 14 pins need a decision. The other notes need none.

The first revision counted those three stores. The two groups name six repositories, and the four others hold stores too. This revision counted them later the same day, when the three stores above had grown by a few notes.

| Store | Notes | Live | Summaries | Open threads | Pins | Under version control |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| durable-automations | 168 | 144 | 3 | 20 | 0 | Yes, in the code history |
| dotfiles | 110 | 94 | 0 | 7 | 2 | Yes, in the code history |
| fleet | 30 | 29 | 0 | 3 | 0 | Yes, in the code history |
| chimr | 30 | 29 | 0 | 4 | 0 | Yes, in the code history |

So step 3 has 34 more open threads and 2 more pins than the first revision said: 96 open threads and 16 pins in all.

## The rule of the migration

No note is rewritten, and no note is lost. The migration adds retirements, notes and summaries. It moves the files of the global store into the scopes they belong to, and it moves each repository's store out of the working tree into the local home. Every step can be repeated, and step 1 makes every step reversible.

The v2 code reads the old files as they are. It ignores `kind` and `pin`, reads `project:<key>` as the repo scope, and leaves a summary without `keeps` out of the start read. It reads a record that sits directly in `notes/`, without the subfolder. It reads the old global folder as the user store until step 4 empties it, and the folder `.tstack/memo/` of a checkout as the repo store until step 6 moves it. So the code can land before any data moves, and the start read is inside its budget from that moment.

## Steps

### 1. Snapshot

`memo migrate snapshot` copies each store to `$XDG_DATA_HOME/tstack/memo/archive/v1-<date>/<store>/`. For custom-mcp-servers and global this copy is the only backup, because neither is under version control. `memo recall` searches the archive, and no start read shows it.

### 2. Groups

Luiz chose two groups on 2026-11-16, `tooling` and `company` ([design.md](design.md#groups)). The file `config/tstack/groups.toml` goes into the dotfiles with step 7, as written there. Nothing asks him to edit it.

### 3. The pass over open threads and pins

memo v2 has no open threads and no pins, and it switches without a list of paused designers in `fleet waiting`. So an agent pass gives each of the 96 open threads and 16 pins one of four ends. Luiz reviews nothing.

**Who runs it.** One Researcher for each store, seven in all, and one Decider for what they cannot place ([models.md](../../models.md)). The work is reading that judges what it finds: each item is read against the repository, `jj log`, the fleets' ledgers and the designers' dossiers. That is the Researcher's row, and one agent per store keeps each reading small. The rows that a Researcher marks "unsure" go to a single Decider, because its call replaces the one Luiz would have made and nothing reviews it afterwards. A Decider is one agent, never a fan-out.

| End | When | What the pass does |
| :-- | :-- | :-- |
| Knowledge | The item states a fact or a limit that will hold for months, and passes the admission rule | Supersedes it with a plain note that states the fact, in the right scope. A pin that states such a fact becomes an ordinary note the same way |
| Done | A change id or a file shows the outcome | Retires it with that evidence as the reason |
| Its owner has it | The item is unfinished work, and its owner's record exists | Writes one line into that record, then retires the item with a pointer to the record |
| Unplaced | Anything else: no evidence, no owner, or the Decider cannot tell | Retires it with the reason "unplaced" and lists it in the report file |

A retired item leaves the start read and stays in the store, where `memo recall` finds it with its reason.

**How the pass finds an owner.** A note's `by` field holds the id and the role of the session that wrote it.

- A coordinator's or a manager's note belongs to a fleet. The pass looks for that session among the fleets that `fleet ls` lists. When the fleet is still served, it writes the line into the fleet's ledger with `fleet state --fleet <name> event --kind note "<the line> (memo <id>)"`. A note event opens no card, so `fleet waiting` does not change.
- A designer's note belongs to a dossier. The role in `by` does not name a designer, so the pass looks up the session in tape, which records its working folder. A designer's folder holds `dossier.md`, and `fleet council list` names the same path where the council exists. The pass appends the line to the dossier under a heading "From memo", with the note's id.
- Any other session has no record that outlives it. Its unfinished work has no owner, so the item is knowledge, done or unplaced.

**What the pass never does.** It opens no decision, input or permission card. It files no issue. It proposes no line for AGENTS.md or CLAUDE.md, and it sends no message to Luiz. It never writes an outcome that it did not find, which is the failure of 2026-11-16, when a designer declined to close other sessions' threads because the answer would have been one it made up. An item that waited on Luiz and has an owner goes into the owner's record, and the owner asks him by its own rules, if it still needs to.

A pin is a standing rule. A pin that still holds becomes an ordinary note in its scope: the repo scope for a rule about one repository, the user scope for a rule about Luiz everywhere. It then competes for the start read like any note. A place in AGENTS.md or CLAUDE.md would keep it in every session, and that is a change Luiz can make on any day. The pass does not propose it.

**The report.** The pass writes `$XDG_DATA_HOME/tstack/memo/archive/v1-<date>/pass-report.md`: the count for each end, and each unplaced item with its id and store. It is a local file outside every repository, because it quotes notes of company repositories. Nothing links it from a page or a card.

How a ledger and tape record a session id was not checked for this design. Where the lookup finds nothing, the item has no owner, and the rules above still give it an end.

`memo migrate apply <file.tsv>` applies the rows. The file has one row per item: the id, the action (`retire`, `supersede`, `refile` or `keep`) and its argument (the reason, the new line, or the scope). Every row is valid or nothing is written, as `memo import` works today.

### 4. Re-filing the global store

The global store mixes four things. One Researcher reads its 254 live notes and gives each a target.

| The note is about | Target | Example of the test |
| :-- | :-- | :-- |
| Luiz: how he wants things done, in any repository | `user` | It would be true in a repository he creates tomorrow |
| One computer only | `machine:<name>` | It names hardware, or something installed outside the dotfiles |
| How the machines are configured | `repo:luizhcrocha/dotfiles` | It names a module, a flake input, or a file of the dotfiles |
| A tool that several repositories use together | `group:<name>` | A session in any repository of the group would pay to rediscover it |
| One repository after all | `repo:<owner>/<repo>` | It names that repository's files |
| Work or status | Retired | It fails the admission rule |

A note the Researcher cannot place goes to the Decider of step 3. In doubt between two scopes, the narrower one wins, because every session reads the user scope and nobody reviews the list. What the Decider cannot place is retired as "unplaced" and listed in the report file.

`memo migrate apply` moves each file to its new store, into the subfolder of its id, and rewrites its `scope` field. This is the one place where the migration changes a file. The id, the time, the author and the text stay as they are. The 49 summaries of the global store cover notes that now sit in different scopes, so they stay in the snapshot and in no store. The 7 open threads and 3 pins of global were settled in step 3.

### 5. First picks

After steps 3 and 4 every old note is live or retired, and no summary is in effect. Each store is then far over its slice, so the start read shows its newest notes and a count line. The picks bring the older knowledge back.

`memo tasks` lists every group. Researchers answer them in batches, with the admission rule as the test for what to keep, and with "keep none" as a valid answer for a group of status lines.

| Store | Live notes | Tasks, about | Reading, about |
| :-- | :-- | :-- | :-- |
| skills | 107 | 14 | 35 KB |
| durable-automations, dotfiles, fleet and chimr | 296 in all, before step 3 | 35 | 90 KB |
| user, machines and groups | 244 in all | 80 to 180, by how the notes divide | 100 KB |

custom-mcp-servers gets no picks. Luiz decided on 2026-11-16 that it starts fresh. Its 4,101 old notes stay in the archive of step 1, where `memo recall` finds them, and no start read shows them. Step 3 still runs on its 49 open threads and 11 pins: an item that is knowledge becomes a new note in the fresh store.

### 6. Each repository's store leaves the working tree

For each of the six repositories:

1. `memo migrate store` copies the records of `.tstack/memo/` into `home/repo/<owner>/<repo>/`, each into the subfolder of its id. For custom-mcp-servers it copies only the notes that step 3 wrote.
2. One change in the repository removes `.tstack/memo/` from the working tree and adds it to `.gitignore`. It lands like any change. custom-mcp-servers needs no change, because it ignores `.tstack/` already.
3. The first sync creates the `memo` bookmark on the remote. No step runs it: the landing of the change above syncs once step 8 is in place, and so does the next `entropic-update`.

The old notes of five repositories stay in their code history up to that change. One of the five, skills, is public, and its notes were public before.

### 7. The dotfiles

One change in the dotfiles:

- `config/tstack/groups.toml`, and `memo.toml` and `groups.toml` in `$XDG_CONFIG_HOME/tstack/` through home-manager. `memo.toml` has the machine's name in the flake and the dotfiles' remote.
- The memo step in `bin/entropic-update` after the pull: find memo and run `memo sync --all`. A machine with no memo skips the step ([sketch.md](sketch.md)). The update commits nothing for memo.
- The `memo-dream` service and timer leave `modules/hosts/cr-sede-pc.nix`, and `bin/memo-dream-night` is deleted.

The machine, group and user stores are on the dotfiles' `memo` bookmark, with the dotfiles' own notes. The next `entropic-update` on the admin machine pushes them. The next one on each other machine fetches them, with the `memo` bookmark of each repository that has a store there.

### 8. The land playbook

Step 7 of tuca-mode's land playbook gains `memo sync` after its push. `scripts/land-check` loses its rules for memo notes among a stack's files.

### 9. Measure

`memo doctor` on the day of the cutover and 14 days later, the needle test, and the audit of new notes ([measures.md](measures.md)). The fleet that builds memo v2 owns these runs and writes each result to a file.

## What Luiz does

Nothing that is new. He approves landing pushes in 1Password and runs `entropic-update`, as he does today, and the notes travel with both. He reads no triage page, edits no file and answers no question for this migration.

## Order and risk

| Step | Can be undone by | Blocks |
| :-- | :-- | :-- |
| The v2 code | Reverting the change. The old files were not touched | Everything below |
| 1 Snapshot | Nothing to undo | 3, 4, 6 |
| 2 Groups | Editing the file | 4 (the group targets) |
| 3 The pass | The snapshot. Retirements and new notes are files, so removing them restores the threads. A line written into a ledger or a dossier stays, and it names the memo id it came from | Nothing |
| 4 Re-filing | The snapshot | 5 for the home stores, 7 |
| 5 First picks | Retiring the summaries, or removing their files | Nothing |
| 6 Stores leave the working tree | Reverting the change that removed `.tstack/memo/`. The `memo` bookmark can be deleted on the remote | Other machines reading that repository's notes |
| 7 Dotfiles | Reverting the dotfiles change | Other machines reading the machine, group and user stores |
| 8 Land playbook | Reverting the change | Notes reach the remote only with `entropic-update` |

The risk that the pass accepts is a thread retired as "unplaced" that still mattered. Nobody is told. `memo recall` finds it, the report lists it, and a session that meets the same question again writes it down again, as a note or in its owner's record.
