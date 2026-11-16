# memo v2: implementation state

The resume point of the build of [design.md](design.md) and [sketch.md](sketch.md). It was written on 2026-11-16, when the Implementer's context ran short.

## Done

| Change | What it holds |
| :-- | :-- |
| memo v2 core | `scripts/memo` rewritten: records as three NamedTuples, four scopes, groups and `memo.toml`, stores in `home/` with subfolders by the first 4 ULID characters, legacy folders read until a `MIGRATED` file, `View` with the in-effect rule of `merge.cfg`, `select` (open and evict), count lines with their words, tasks, writes with advice, `retire`, `supersede`, `summarize`, recall with folded look-alikes, zoom, doctor, import, export, reindex, and the `memo migrate` entry point. `scripts/tape` and the hook call `memo.repo_key`, and the hook's SessionStart calls `start_text`. `scripts/tests/test_memo.py` is rewritten: Hypothesis properties for the model's rules (WithinBudget, OnlyLiveNotes, NeverTwice with Accounted, NewestWordForWord, KeptNotesStay, NoBrokenSummary, the union of two machines' stores with SameFilesSameRead), tasks that bring the cover inside, the hint words, and CLI tests (refusal reasons, no space refusal, scopes, concurrent writers, legacy stores, no stat and no process at start). `test-scripts` runs under `uv run --with hypothesis` |
| memo v2 prose | The memo skill rewritten, the land playbook's `memo sync` in step 7, and every other v1 reference in skills, READMEs and `docs/models.md`. [dotfiles-patch.md](dotfiles-patch.md) describes the dotfiles change |

`uv run --no-project --with "hypothesis>=6.170" python3 -m unittest scripts/tests/test_memo.py scripts/tests/test_tape.py`: 71 tests pass, 1 skipped (the timing test, which runs with `MEMO_TIMING=1`).

The start read on a generated store of 42,000 notes takes 33 to 38 ms with the index current (target: 100 ms). The first read after the store's file names change takes about 180 ms: it reloads every row to compute the section again.

## Next

1. **The hook.** Delete `memo_nudge`, `NUDGE`, `_NOTED`, the `memo` hook state, `memo_precompact`, `memo_dream_report`, `DREAM_KEPT` and `DREAM_STUCK`. Rename `memo_wake` to `memo_start`. Remove the `PreCompact` entry from `hooks/hooks.json` and from `HANDLERS`. Update `scripts/tests/test_tstack_hook.py`: its tests still write `memo note decision …` (v1 form) and test the nudge, the PreCompact text and the dream report. Add the test that the hook module never calls a sync.
2. **memo-dream.** Delete `scripts/memo-dream` and `scripts/tests/test_memo_dream.py`. The timer is in the dotfiles: [dotfiles-patch.md](dotfiles-patch.md) covers its removal.
3. **Sync.** `sync_bookmark`, `waiting`, `cmd_sync` and the `sync` subparser, plus `sync_lines` in `memo doctor` (now a stub that returns nothing), as the sketch's table of five git steps says. Use `git cat-file --batch` for the import and `git update-index --index-info` with a temporary `GIT_INDEX_FILE` for the tree. Run git with `-c core.hooksPath=/dev/null -c commit.gpgsign=false`. Sync only `Store.dir`, never a legacy folder, so a global note is never pushed before migration step 4 re-files it. Tests against a bare repo in a temporary folder: the seven bullets in sketch.md's Tests.
4. **The migration tool.** `scripts/memo-migrate`, loaded by `memo migrate`. Its steps are `snapshot`, `apply <tsv>` (retire, supersede, refile, keep; all rows or none), `store` (copy `.tstack/memo` into the home store, subfoldered, then write `MIGRATED`; for custom-mcp-servers copy only notes written by the pass) and `report`, each with `--dry-run`. Then run it in dry run on copies of the real stores in the scratch directory, and report counts only.
5. **land-check.** Drop the memo rules (`.tstack/memo/`) from `scripts/land-check` and its tests. land.md already assumes they are gone.
6. **Lint.** Run `ruff` on `scripts/memo` and remove any comment that narrates.

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

## Open questions

- The Writer flagged that a sync before migration step 4 would push global notes into `user/`. The code prevents that by syncing only `Store.dir`. Step 4 re-files only the admin machine's global store. A global store on another machine stays a legacy folder until a migration runs there too.
- `memo recall` searches the session's stores and the archive by default, and every indexed store with `--all`.
