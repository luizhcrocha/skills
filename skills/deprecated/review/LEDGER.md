# Recording a review in the fleet ledger

In a fleet (`fleet` on PATH), [review](SKILL.md) records every review in the ledger before the stack lands, so `land-check` finds it:

```
fleet state <dashboard-dir> event --kind reviewed --findings <N> --proven <P> --changes "<change>@<commit>,..." "<what was reviewed, and with what>"
```

- `--changes` is the report's `Read:` line (step 1). A bare change id is refused.
- N is the findings of both axes (0 when there were none), P the Important ones that carry a proof. A bug hunt and a Deep review count their own way ([BUG-HUNT.md](BUG-HUNT.md), [DEEP.md](DEEP.md)).

`land-check` passes a change only while `jj interdiff` from the reviewed commit to its current one is empty. A fix squashed in after the review needs a re-check of that interdiff, recorded at the commit the re-check read.
