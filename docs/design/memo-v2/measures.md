# How to know it works

The targets, how each is measured, the tests that run before the cutover, and the failure modes with what prevents each.

## Targets

`memo doctor` prints every number in this table that memo can count. The baselines were measured on 2026-11-16.

| Target | Baseline | Target | Measured by |
| :-- | :-- | :-- | :-- |
| Size of the start read | custom-mcp-servers 46,517 bytes, about 11k tokens. skills 16,456 bytes | At most 14,000 bytes in every repository on every machine, at every start. About 4,000 tokens | An assertion in `start_text`, a test over random stores, and `memo doctor`. One token count of two real start reads after the migration |
| Time of the start read | The hook took 42 ms in October. On 4,101 notes, listing the file names takes 1.5 ms, a stat of each file 12 ms, and a read of each file 45 ms | At most 50 ms on 4,101 notes and at most 100 ms on 42,000, with the index current. No stat and no read of a record file that the index already has, and no git or network call | A test that counts `stat` calls and fails on any started process, and a timed run on the archive and on a generated store of 42,000 notes |
| Writes refused for space | 9 refused at the cap. Those of 11-10, 11-12 and 11-16 were dropped | 0 | `Refusal.reason` has no such value. The refusal log holds only length, secret, role and usage |
| Refused writes that were dropped | About 99 refusals for length since 10-02. How many were dropped is not known | Under 1 in 10 refusals with no write by the same session in the next 5 minutes | The refusal log, joined with the notes' `by` and `at` |
| Write rate in custom-mcp-servers | 117 notes a day over 35 days | About 20 a day, over days 8 to 14 after the cutover | Note files by date |
| Notes that are knowledge | Not measured. 10% of live notes name a commit or a landing word | At least 45 of 50 | The admission audit below |
| Look-alike pairs | 201 live pairs in 3,933 notes: 5 for every 100 notes | Under 1 for every 100 notes written after the cutover | The word-overlap test that `memo doctor` has today, on the new notes |
| Sessions still find what they need | Not measured | 18 of 20 needles, in at most 3 commands each, and no fewer than today finds | The needle test below |
| Recall at scale | Not measured. The old custom-mcp-servers store has 201 look-alike pairs in 3,933 live notes, and a search prints each note of a pair | For the 20 needle questions on that store: no result among the first 5 shares half its words with a result above it, and the answer is among the first 5 for at least 18 | The recall test below |
| Stores over their slice at session start | Not applicable | 0 after the first picks | `memo doctor` |
| A kept note hidden while a note outside a summary is shown beyond the newest quarter | Not applicable. The first revision allowed it | 0 | `KeptNotesStay` in the model, and the same property on random stores |
| Words on a count line that no hidden note contains | Not applicable | 0 | A property test of `hint_words` |
| Notes that wait over 7 days for a sync, in any store | Not applicable | 0 | `memo doctor`. Nothing prompts anybody: they leave with the next landing or update |
| Cards, questions or pages that memo or its migration puts in front of Luiz | The first two revisions asked for a triage page of 96 threads and 16 pins, a list to read and six syncs to run | 0 | `fleet waiting` before and after the pass of [migration.md](migration.md), and the pass's report file |
| Syncs started by a hook or a timer | Not applicable | 0 | A test: the hook module never calls `sync_bookmark`, and `hooks.json` names no sync |
| Open threads in memo | 62 | 0 | No such record exists |

## Tests before the cutover

### The model

[model.md](model.md): twelve rules hold over 7,776 states of two machines that exchange files, and over 52,491 states of two machines that exchange them through a `memo` bookmark.

### The property tests

[sketch.md](sketch.md), "Tests": the same rules on random stores in bytes, the union of two random stores, the tasks that always bring a store back inside its slice, the closed set of refusal reasons, and concurrent writers. The bookmark sync runs against a bare repository in a temporary folder: two stores reach the union, a push on an old fetch is refused and then gets through, and no sync removes a path.

### The needle test

The method is tape's ([tape.md](../tape.md), "Needles").

1. Before the cutover, a Researcher picks 20 needles from tape's turns of the last 30 days: moments where a session used memory. It ran `memo recall` or `memo zoom`, or its reply cited a note id. Each needle is a question, the note that answers it, and the note's store. At least 5 answers are notes over 30 days old, and at least 5 are in the global store.
2. A needle whose note the pass of the migration retires leaves the set, and the report says how many did.
3. After the migration, three fresh Sonnet sessions answer the 20 questions, each with only its tools:
   - today's start read and `memo recall`, on the snapshot;
   - the v2 start read, `memo recall` and `memo zoom`;
   - the v2 start read alone, with no command.
4. The report gives, for each, the needles found, the commands for each hit and the tokens for each hit.

The bar is 18 of 20 for the second session, in at most 3 commands a hit, and no fewer than the first session found. The third session shows how much of what sessions need is in the read itself.

### The recall test

It uses the 20 needle questions on the archive of the old custom-mcp-servers store, which holds the most notes and the most look-alikes. For each question, the test runs `memo recall` with the question's words and reads the first 5 results. It counts the results that share half their words with a result above them, and it records whether the needle's note is among the 5. It runs once with today's `memo recall`, for the baseline, and once with v2. The same run on a generated store of 42,000 notes gives the time of one search.

### The admission audit

An Opus Reviewer with read access to the repository marks 50 random notes as knowledge, status, a work item, already in code, docs or commits, or a repeat. It runs once on notes of the 14 days before the cutover, for the baseline, and once on notes written after it. The bar is 45 of 50.

### The faithfulness check

It ran on 2026-11-16 and failed. 8 of 30 rewritten summaries state something their sources do not ([the evidence](evidence/faithfulness-2026-11-16.md)). That is why a summary quotes ([ADR 0007](../../adr/0007-summaries-quote-notes.md)). With summaries that quote, the check has nothing to test: the start read prints note files, and a property test proves it.

Luiz chose summaries that quote ([decision 1](decisions.md)). A second test put the two shapes side by side with Haiku compressing ([the evidence](evidence/compress-2026-11-16.md)). A rewritten line states something false in 5 of 30 cases at level 1 and in 5 of 8 at level 2. Quoted notes state nothing false. Their one fault is a kept note that a later note contradicts, in 1 of 30 cases and 2 of 8, which the task over summaries now asks the session to retire.

## The simulation

The notes of today's stores were replayed in time order under the design's rules. After each write, the simulation answered the tasks that the design offers and kept the first notes offered. The simulation cannot judge what to keep. It measures sizes and counts only.

| Store replayed | Slice | Group | Tasks | Section after a write, median and peak | Over its slice | Notes read word for word at the end |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| custom-mcp-servers, 4,100 notes | 6,000 | 11 | 1 for every 6.7 notes | 5,259 and 6,000 bytes | Never | 23 |
| skills, 133 notes | 6,000 | 11 | 1 for every 9.5 notes | 4,921 and 6,000 | Never | 18 |
| global as the user store, 280 notes | 3,000 | 5 | 1 for every 3.7 notes | 2,600 and 2,999 | Never | 8 |
| global as one group's store | 2,500 | 4 | 1 for every 2.2 notes | 2,229 and 2,499 | Never | 8 |
| global as a machine's store | 1,900 | 3 | 1 for every 1.5 notes | 1,742 and 1,900 | Never | 5 |
| global as one of two groups' stores | 1,250 | 2 | 1 for every note | 1,150 and 1,250 | Never | 3 |

The table is from the first revision, with a count line of 72 bytes. This revision adds up to 3 words to the count line. The replay ran again with a count line of 120 bytes, on stores that had grown by a few notes.

| Store replayed | Slice | Tasks | Section after a write, median and peak | Over its slice |
| :-- | :-- | :-- | :-- | :-- |
| custom-mcp-servers, 4,101 notes | 6,000 | 1 for every 6.2 notes | 5,303 and 6,000 bytes | Never |
| skills, 142 notes | 6,000 | 1 for every 8.9 notes | 4,986 and 5,992 | Never |
| global as the user store, 281 notes | 3,000 | 1 for every 3.3 notes | 2,608 and 3,000 | Never |
| global as one group's store | 2,500 | 1 for every 2.1 notes | 2,256 and 2,500 | Never |
| global as a machine's store | 1,900 | 1 for every 1.6 notes | 1,721 and 1,899 | Never |
| global as one of two groups' stores | 1,250 | 1 for every note | 1,089 and 1,250 | Never |

The words cost about one task more for every 13 in the repo store, and the sections stay inside their slices.

Two things follow.

- The budget holds about 44 notes: 23 for the repo and about 21 for the other scopes. That is what 4k tokens buy. The read is short on purpose, and `memo recall` is the way to the rest.
- A small slice is costly. Under about 1,900 bytes a store holds 3 to 5 notes and needs a task for almost every write. A repository in two groups gives each group 1,250 bytes, which is why two groups is the limit. The machine, group and user stores get few notes (the global store holds 278 notes for all three, from every session since memo began), so the cost is small in absolute terms. The split is five constants in the code.

## Failure modes

| What can go wrong | What prevents it | What shows it |
| :-- | :-- | :-- |
| The start read grows again, as when the brief replaced the budgeted listing | Every part of the read has a slice. `start_text` asserts the total. A test fails on any path over it ([ADR 0006](../../adr/0006-the-start-read-is-bounded-not-the-store.md)) | `memo doctor` |
| The start read gets slow as a store grows | It lists file names and parses only new files. Record files sit in subfolders of 12.4 days | The timed run, and the test that counts `stat` calls |
| Sessions keep writing status and work | The rule is in the skill and in the header. Nothing nudges. `memo note` answers a commit hash or a landing word with advice. No kind `open` exists | The write rate, the admission audit |
| Sessions stop writing knowledge, since nothing reminds them | Nothing prevents it. This is the risk the design accepts | The needle test repeated at day 14, and a write rate far under 20 a day in custom-mcp-servers |
| A note goes to too wide a scope, and every session reads it | The default is the repo. `--scope user` and `--scope group:` print who will read the line | The audit, run on the user and group stores |
| A group or user note carries company material to the dotfiles' remote | The skill forbids clients, cases and case material outside the repo scope. The secret patterns still apply | The audit. Nothing mechanical |
| Compaction tasks are ignored | The read stays inside its slice and prints the count line. `memo tasks` lets one session or several clear a backlog | `memo doctor`, stores over their slice |
| A burst of new notes hides the notes that summaries keep | In a store over its slice, the oldest notes outside a summary leave first (`KeptNotesStay`) | The count line of the section |
| A summary keeps the wrong notes | `memo zoom` and `memo recall` still reach the others, and the count line names their words. `memo retire` on the summary puts its notes back in line for a new pick | The needle test |
| A summary keeps a note that a later note contradicts | A task over summaries tells the session to retire or supersede it. A retired note leaves the read under every summary | The audit, run on kept notes |
| Two machines write summaries over the same notes | The selection takes the one that stands for more notes and ignores the other ([model.md](model.md)) | `memo doctor` lists summaries not in effect |
| A summary's lower summary is retired | The upper one goes out of effect with it, and its notes return to the cover (`NoBrokenSummary`) | The count line, then a task |
| A sync stalls on a 1Password approval that nobody gives | No hook and no timer runs a sync. A fetch or a push stops after 20 seconds, and the notes stay in the local store | The line that `memo sync` prints, and the waiting count |
| Notes never reach a remote | Every landing and every `entropic-update` syncs. Nothing else prompts, and the notes are whole in the local store meanwhile | `memo doctor` counts them |
| The migration's pass retires an open thread that still mattered | Nothing prevents it. The pass never invents an outcome, and it writes a thread into its owner's record where one exists | The pass's report file lists every unplaced item, and `memo recall` finds it |
| The pass puts work in front of Luiz | It opens no card and files no issue. A line in a fleet's ledger is a note event, which `fleet waiting` does not list | `fleet waiting` before and after |
| Two machines push the same bookmark at once | The remote refuses the second push. That machine fetches, imports and pushes again. No push is forced (`SettledMeansEqual`) | The line that `memo sync` prints |
| A sync removes notes from a bookmark | The commit is built from the bookmark's tree plus new files (`FilesOnlyGrow`) | The sync test |
| A push of `memo` starts CI or a deploy | None of the six repositories has a workflow that a `memo` push matches, and the tree of `memo` holds no workflow file ([design.md](design.md#what-a-push-of-memo-triggers)) | The Actions page of each repository after the first sync |
| A repository has no remote | Its store is local, with no backup | `memo doctor` |
| Another writer moves a working copy, of a repository or of the dotfiles, or an agent works in its own jj workspace | No note is in a working copy. Every checkout and workspace of a repository reads one local store | Not applicable |
| The dotfiles checkout sits on a commit with an older `groups.toml` | memo reads the copy that home-manager installed, which changes only at a rebuild | `memo doctor` |
| `groups.toml` names a repository in three groups | memo reads the first two by name and names the others in the start read | The start read, `memo doctor` |
| A repository's origin changes, so its key changes | Nothing prevents it | `memo doctor`: a repository in no group, and group entries that match no repository on the machine |
| The machine has no `memo.toml`, or the file names no machine | memo never takes the host name. The machine scope is off, and the Machine section says so | The start read, `memo doctor` |
| A new machine runs `entropic-update` before tstack is installed | The update finds no memo, skips the memo step and says so | The update's output |
| Look-alike notes fill the first results of a search | `memo recall` folds a result under the result it repeats | The recall test |
| A fleet worker writes | The role check, as today | Exit 3 |
| A secret is written | The secret patterns refuse it, as today | Exit 2 |
| An old open thread or pin stays live after the migration | `kind` and `pin` are ignored, so it reads as an ordinary note. The pass of the migration gives each one an end | `memo doctor` counts old notes of kind `open` that no retirement names |
| The index is stale or corrupt | It is a cache. memo rebuilds it from the files, and reads the files when SQLite fails, as today | `memo reindex` |
| A record file is changed by hand, so the index and the file differ under the same name | Nothing prevents it. memo never edits a file | `memo doctor` compares every file with the index |

## What is not measured

- Whether a session works better with 44 chosen notes than with 46 KB of notes. The needle test measures finding, not use.
- The token count. 14,000 bytes is 4,000 tokens at 3.5 bytes a token and 3,300 at the 4.2 that today's read shows. Neither was counted by a tokenizer.
- The cost of the first picks on the plan's usage.
- Whether one 1Password approval covers the landing push and memo's push after it. One landing on a real remote answers it.
- Whether the words on a count line lead a session to the right `memo zoom`. The third session of the needle test is the nearest measure.
- The time `memo sync --all` adds to `entropic-update` with a fetch for every remote.
- How many of the 96 open threads end as "unplaced". The pass's report gives the number.
