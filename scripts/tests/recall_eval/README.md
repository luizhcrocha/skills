# memo recall eval

A gold set and a scorer for `memo recall`, the way a brief's note selector uses it: the task's words in, the top 3
notes out. It answers two questions about a candidate recall: does it put notes a worker would act on in its top 3,
and does it say nothing when no such note exists.

## Where the gold set lives

Outside the repo, in `~/.local/state/tstack/memo-eval/`:

| File | What |
| --- | --- |
| `rows.jsonl` | the sampled fleet rows: task, lane, repo, start time |
| `pooled.jsonl` | each row's pooled notes, with their recall lines |
| `labels/` | the readers' U/N labels, one JSON file per packet |
| `gold.jsonl` | the gold set: each row, its pool and its labels |

Memo notes and fleet task texts carry client names, case details and proceeding numbers, and tstack is a shared
repo, so no note text and no task text is committed here. This directory holds only the code and the method.

## Scoring a recall

```
uv run --no-project python scripts/tests/recall_eval/memo_eval.py score -- <memo path> recall --live --limit 3
```

The scorer runs the command once per gold row as `<command> --cwd <row repo> -- <task words>`, from the row's repo,
after one untimed call per repo that brings its index up to date. Point it at a workspace's `scripts/memo` to score a
candidate. It prints:

- **P@3 over U rows**: per row with at least one useful (U) note, the useful notes among the first 3 hits over 3
  slots, averaged. An abstention returns 0 hits and scores 0. A hit no reader labelled counts as not useful; the
  report counts them (`unjudged hits`), and a candidate that surfaces many should have them labelled before its P@3
  is trusted.
- **Correct-abstain rate**: on the no-answer rows (no U), the share where the command printed no hit.
- **False-abstain rate**: on the U rows, the share where it printed no hit.
- **p95 and max latency** of the timed calls (nearest-rank p95).

An abstention is output with no hit line: `memo: nothing fits`, master's `memo: nothing on '<query>'`, or nothing.
Any other line that is not a hit is an error, so a crash never scores as an abstention.

**Forward cut.** A hit dated after the row's start (a note id is a ULID, so the id carries its time) is ignored: it
is neither hit nor miss, and it takes its slot out of the 3. A note written later about that very task would
otherwise score as a perfect hit. A row whose every hit is cut is left out of all three rates (it neither answered
nor abstained before its start), and is counted.

Real rows and cross-repo rows (below) are scored and printed apart. `--json` prints the same numbers as one JSON
object.

## How the gold set was made

1. **Rows** (`memo_eval.py sample`). Every fleet ledger on this machine (`state.json` under the fleet registry,
   `~/.local/state/fleet-board/{,names/}*.json`, and the host-served fleets under `~/.local/state/fleet/*/`). A row
   qualifies when its status is done, it has a task and a start time, it is not an advisor, its lane names at least
   one path that exists in its repo (`git ls-files` now; a path the task later deleted drops the row), and its
   repo's memo store already held a quarter of today's project notes when it started (the store began about
   2026-10-08; 19 of the first draw's 45 custom-mcp-servers rows started when it held 1% or less, and replaying
   those tests only the forward cut). With seed
   20261021, per stratum: 40 rows from the custom-mcp-servers fleets other than infra, 10 from tstack's fleets
   (notes, skills; repo luizhcrocha/skills), 5 from infra (custom-mcp-servers), 5 from picasso; plus a reserve of 15
   (10, 3, 1, 1) for when too few no-answer rows come out. The 10 rows of skills-f5's SELECTOR.md (perf i10, i46,
   i74; ui-coordinator a29, a105, a161, a236, a260; notes w2, w3) are the frozen dev set and are never sampled.
   **Cross-repo rows.** Real rows turned out to have almost no no-answer rows (4 of the 60 first rows; see
   Results), too few to measure abstention. So 15 more rows are a real task asked of another repo's store, the case
   SELECTOR.md's finding 5 describes (a store with nothing on the task's subject): 8 custom-mcp-servers tasks asked
   of picasso's store, 7 picasso tasks asked of tstack's (picasso's rows all started before custom-mcp-servers'
   store held a quarter of its notes). The pairs are chosen by repo, never by what the pool holds. Their ids start
   with `x:`; two of them reuse a task that is also a real picasso row, asked of a different store. Each has one
   reader, and a cross-repo row a reader finds a U in stays an answer row.
2. **Pool** (`memo_eval.py pool --memo <memo>`). Per row, in the row's repo, the union of the first 10 notes dated
   before the row's start in `recall --limit 50` on the task's words, the same on the lane's paths (globs cut off),
   and the first 3 such notes of `recall --live --limit 3` on the task's words (so the baseline's surviving hits are
   labelled). Taking the top 10 after the cut, not before, stands in for recall's top 10 on the store as it was; a
   plain `--limit 10` then cut left 19 of 60 pools empty on the first draw. The installed
   tstack 1.9.74 memo built the pool on 2026-10-21; its `scripts/memo` is byte-identical to master's.
3. **Labels** (`memo_eval.py packets`, then readers). Each pooled note is labelled U or N by a Sonnet reader on one
   rule: would a worker doing this task act differently having read it. A reader sees the row's task, lane, repo and
   start, and the pooled notes' recall lines, in a Markdown packet of about 10 rows (the last packet: 30, the
   cross-repo rows first), and writes
   `{row id: {note id: "U"|"N"}}`. A row with no U is a no-answer row.
4. **Agreement** (`memo_eval.py agree`). A second reader labelled 20 rows, picked by seed from the 60, on the same
   packets. The report gives raw agreement and Cohen's kappa on the note labels, and on "the row has a U". The gold
   set keeps the first reader's labels.
5. **Gold** (`memo_eval.py gold --labels <files>`) joins the labels to the pooled rows into `gold.jsonl`; it refuses a
   row with a pooled note left unlabelled.

To rebuild: run `sample`, `pool`, `packets`, label the packets (any reader that follows step 3's rule and output
format), then `gold` and `agree`. `pool --keep` pools only the rows not already in its output, so labelled pools stay
as labelled. A redraw does not give the same rows: the ledgers grow and change (a fleet whose dir sits in a session
scratchpad under `/tmp` goes away with it), and the store's quarter mark moves as notes are written, which shifts
the seeded shuffle. Within an hour of the first draw a redraw already differed from the tstack stratum on.
`rows.jsonl` is the record of the draw this gold set was built from (2026-10-21).

## Results (2026-10-21)

The gold set: 90 rows. 75 are real rows, 71 of them with a U and 4 no-answer. 15 are cross-repo rows, 4 with a U and
11 no-answer. That makes 15 no-answer rows and 1,639 labelled notes. The 15 reserve rows added no no-answer row.

**First finding: real tasks almost always have a useful note in the pool.** 4 of 75 real rows have none, about 1 in
19. Abstention cannot be measured on real rows alone at that rate, which is why the cross-repo rows exist.

**Agreement** (20 real rows, 361 notes, two Sonnet readers): the readers gave the same label to 342 of 361 notes
(0.947), kappa 0.853. The first reader gave 85 U and the second 84. On whether a row has a U, they agreed on 18 of 20
rows (0.900) and kappa is 0.000. The two rows the first reader left with no U (perf:r43, notes:w6) each got one U
from the second reader. With one reader calling every row an answer row, chance agreement equals observed agreement,
so kappa is 0 by construction. A no-answer row hangs on single notes, and the cross-repo rows have one reader.

**Baseline**: the installed tstack 1.9.74 `memo recall --live --limit 3` (its `scripts/memo` is byte-identical to
master's at a39b164f):

| Rows | Scored for P@3 | No-answer | P@3 | Correct-abstain | False-abstain | p95 / max latency |
| --- | --- | --- | --- | --- | --- | --- |
| real | 55 | 3 | 0.700 | 0.000 | 0.000 | 0.218 s / 0.255 s |
| cross-repo | 4 | 11 | 0.375 | 0.000 | 0.000 | 0.162 s / 0.162 s |

Master never abstains: it always fills its 3 slots. On real rows the forward cut removed 117 hits, and 16 answer rows
plus 1 no-answer row lost every hit to it, so they leave the rates. None of master's surviving hits was unjudged.

## Limits

- The pool is recall's own top 10 on two keys, so a useful note recall never ranks there is missing from the gold
  set: the scores measure ranking among what lexical recall finds, and a candidate that finds new notes shows them
  as unjudged.
- One reader per row (two on 20). The kappa says how far a single Sonnet label can be trusted.
- Rows are finished work, replayed: the forward cut keeps later notes out, but the store's ranking state (summaries,
  supersessions written since) is today's.

## Tests

The scorer's logic (hit parsing, abstention, the forward cut, P@3, rates, latency, kappa) on invented rows and notes:

```
uv run --no-project python -m unittest discover -s scripts/tests -p test_memo_eval.py
```

The directory has an `__init__.py`, so `just test-scripts` (discovery from `scripts/tests`) runs them too.
