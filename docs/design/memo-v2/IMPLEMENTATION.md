# memo v2: implementation state

The resume point of the build of [design.md](design.md) and [sketch.md](sketch.md). A first Implementer wrote it on 2026-11-16 when its context ran short; a second one finished the list the same day.

## Done

| Change | What it holds |
| :-- | :-- |
| memo v2 core | `scripts/memo` rewritten: records as three NamedTuples, four scopes, groups and `memo.toml`, stores in `home/` with subfolders by the first 4 ULID characters, legacy folders read until a `MIGRATED` file, `View` with the in-effect rule of `merge.cfg`, `select` (open and evict), count lines with their words, tasks, writes with advice, `retire`, `supersede`, `summarize`, recall with folded look-alikes, zoom, doctor, import, export, reindex, and the `memo migrate` entry point. `scripts/tape` and the hook call `memo.repo_key`, and the hook's SessionStart calls `start_text`. `scripts/tests/test_memo.py` is rewritten: Hypothesis properties for the model's rules (WithinBudget, OnlyLiveNotes, NeverTwice with Accounted, NewestWordForWord, KeptNotesStay, NoBrokenSummary, the union of two machines' stores with SameFilesSameRead), tasks that bring the cover inside, the hint words, and CLI tests (refusal reasons, no space refusal, scopes, concurrent writers, legacy stores, no stat and no process at start). `test-scripts` runs under `uv run --with hypothesis` |
| memo v2 prose | The memo skill rewritten, the land playbook's `memo sync` in step 7, and every other v1 reference in skills, READMEs and `docs/models.md`. [dotfiles-patch.md](dotfiles-patch.md) describes the dotfiles change |
| memo sync | `sync_bookmark`, `waiting`, `sync_targets`, `memo sync [--all]` and `sync_lines` in `memo doctor`, as the sketch's five git steps: fetch into `refs/memo/remote` of memo's own bare directory, import with `git cat-file --batch`, the tree from the fetched one through `git update-index --index-info` and a temporary `GIT_INDEX_FILE`, `commit-tree --no-gpg-sign`, push without force, 3 tries, 20 s for each fetch and push, a lock file for each bookmark. Only the home stores are synced, never a legacy folder. Seven tests against bare repositories in a temporary folder, with two machines |
| memo hook | `memo_start` replaces `memo_wake`; the Stop nudge, the PreCompact request and its `hooks.json` entry, the memo-dream report and the hook's session state are deleted. `scripts/memo-dream` and its tests are deleted. A test runs the SessionStart dispatch with `sync_bookmark`, `subprocess.run` and `subprocess.Popen` replaced by functions that fail |
| memo migrate | `scripts/memo-migrate`: `snapshot`, `apply <tsv>`, `store [--fresh \| --global]` and `report`, each with `--dry-run`, each safe to run again (`apply` skips the rows of its log) |
| land-check | No memo rules: a `.tstack/memo/` path is no longer quiet, gate-free or skipped by the review check. Review records keep those rules |
| reflect | Backlog rows are in the step-5 approval table. Only approved rows become issues or lint-evolve runs; the others are listed as dropped. Squashed into the prose change |
| dotfiles patch | The memo step in `entropic-update` moves after the switch (below) |

Fixed on the way, in the core change: `scripts/memo` had lost its executable bit, and the hook's SessionStart cost 2.2 to 2.4 times a bare Python start, over the 2.1 the hook tests allow. `dataclasses` alone took 9 ms to import; the records of the core are now `NamedTuple`s, and `tomllib` loads only when `memo.toml` exists. The hook is back at 1.3 to 1.7 times.

The migration ran in dry run, then for real, on copies of the six repositories' stores and the global store in a scratch folder, with every open thread and pin retired as "unplaced" as a stand-in for the pass's file. No original was touched, and the dry runs wrote no store or archive file.

| Store | Record files | Open-thread or pin files | `store` copies | Start read after |
| :-- | --: | --: | --: | --: |
| custom-mcp-servers | 4,360 | 129 | 0 (`--fresh`) | 3,279 bytes |
| skills | 151 | 19 | 151 | 9,090 bytes |
| fleet | 30 | 4 | 30 | 9,122 bytes |
| dotfiles | 110 | 18 | 110 | 9,045 bytes |
| durable-automations | 171 | 31 | 171 | 9,049 bytes |
| chimr | 30 | 4 | 30 | 9,042 bytes |
| global | 332 | 20 | refused: 256 live notes without an end | |

"Open-thread or pin files" counts every note file with `kind = "open"` or `pin = true`, closed or superseded ones included, so it is above migration.md's live counts.


`just test-changed` on the stack: see the last section.

The start read on a generated store of 42,000 notes takes 33 to 38 ms with the index current (target: 100 ms). The first read after the store's file names change takes about 180 ms: it reloads every row to compute the section again.

## Next

1. **The pass** (migration step 3) and **the re-filing** (step 4): the Researchers and the Decider write the TSV files that `memo migrate apply` takes. Nothing in the code is missing for them.
2. **Each other machine's global store.** v1 kept a global folder on each machine, never synced. Step 4 runs on each machine that has one, after the admin machine's sync has brought its re-filed notes there: `memo migrate snapshot`, a Researcher's TSV for the notes still live, `memo migrate apply`, then `memo migrate store --global`. `store --global` counts a note as placed when a home store already holds its id, so the notes the admin machine re-filed need no row. Until then the user store on that machine reads its old folder, and no sync sends it, because a sync takes only the home stores.
3. **A new machine's first `entropic-update`.** With the step after the pull, as design.md places it, the first update runs `memo sync --all` before the switch installs `memo.toml`. memo then has no `home_remote` and no machine name: it says so in one line, exits 0, and syncs only repositories that have recorded an origin, which a new machine has not. The user, machine and group stores would wait one more update. [dotfiles-patch.md](dotfiles-patch.md) now puts the step after the switch, so the first update installs `memo.toml` and syncs in the same run.
4. **Steps 5 to 9** of migration.md, and the dotfiles change, which a session in the dotfiles makes.

## Choices the spec did not settle

| Choice | Why |
| :-- | :-- |
| The index file is `memo-v2.db`, not `memo.db` | During the switch, the old plugin and v2 run on one machine. With one file, each would drop the other's tables on every schema check |
| `select` is memoized in the index, keyed by a digest of the store's file names | `select` is a function of the files, and a file is never edited, so equal names give an equal section. Without it the read took 180 ms on 42,000 notes |
| The count line skips stopwords and words that look like a short id | The rule says "most distinctive". The property still holds: every word printed is a word of a hidden note |
| A summary whose live notes are all kept prints no count line | A line that counts nothing tells a session nothing |
| `memo note --scope group` with no name takes the repository's group when it reads exactly one | That is the case for every repository in Luiz's two groups |
| `memo summarize` refuses the newest live note and any id that is not a line of the cover | The model's `CanSummarize` refuses the newest live note. An id under another summary would make two summaries stand for one note |
| A summary above level 1 that names an id the store lacks is not in effect until that file arrives | Such an id may be a summary not yet synced, and treating it as a note could tell a note twice |
| Hypothesis comes from `uv run --with` in `test-scripts` | The repo has no dev shell, and Luiz's rule is uv for every Python environment |
| A sync commit's author is `memo <memo@localhost>` | Luiz's git identity may be unset or bound to signing, and the bookmark shares no history with the code |
| `memo sync` prints counts of files, not of notes | A sync also carries summaries and retirements |
| A fleet worker's `memo sync` is refused with the role exit code | A worker never writes memory, and the import writes files into the stores |
| `refile` takes only notes of the old global folder, and moves the file | migration.md's step 4. A note left in both places would be read twice until `MIGRATED` |
| `apply` logs each row to `archive/v1-<date>/applied.tsv`, which `report` reads | The report needs the ends, and a second run must not retire a note twice |

## Open questions

- `memo doctor` does not yet report a path that has two contents (design.md's case table). The sync never changes the bookmark's copy, and the local file stays, so nothing is lost; only the report is missing.
- `memo recall` searches the session's stores and the archive by default, and every indexed store with `--all`.

## Tests

`just test-changed` on the stack (2026-11-16): the design's model files match no pattern of `SCOPE`, so it chose every suite. test-scripts, test-lint-ts, test-mods and validate pass. `ruff check` leaves two findings in `scripts/memo`: a `ValueError` for a bad type in `groups.toml`, which its callers catch as a parse error, and the stopword list written as one split string.
