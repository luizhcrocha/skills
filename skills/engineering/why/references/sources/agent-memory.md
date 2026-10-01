# Agent Memory (memo, the claude-mem archive, fleet ledgers)

## What this source contains

What earlier agent sessions learned and decided, often the only record of a decision made in a session that never reached a doc.

- **memo**: deliberate one-line notes kept in the repo (`.tstack/memo/`), each of a kind: `decision` (a choice and its reason), `gotcha`, `preference`, `fact`, `open`; plus summaries that fold several notes into one line. Global notes live outside the repo.
- **The claude-mem archive**: automatic observations and session summaries from before memo (archived 2026-09-30, read-only).
- **Fleet ledgers**: the `state.json` of coordinator sessions, whose `decisions` hold questions put to Luiz with the options, his answer and how it was resolved.

A memo `decision` note is written on purpose and states its reason: close to Direct evidence. claude-mem observations are machine narration: treat them as circumstantial unless one quotes the user or a decision.

## How to search it

Read only. Never write a note, open the archive writable, or run a state command that changes a ledger.

**memo** (on the Bash PATH through the tstack plugin):

```
memo recall <words>          # the project's and the global notes
memo recall <words> --all    # every repo indexed on this machine
memo zoom <ID>               # what a summary covers
```

A note marked `superseded by` is history: report both, the newer one as current. The notes are files, so their history is in the repo too (`jj log -r '::@' -- .tstack/memo`): the change that added a note usually carries the work it came from.

**The claude-mem archive**, when `~/.local/share/claude-mem-archive/claude-mem.db` exists (the `recall` skill's third source), opened read-only:

```
sqlite3 "file:$HOME/.local/share/claude-mem-archive/claude-mem.db?mode=ro" "<query>"
```

- `observations` (`id`, `project` = the repo folder's name, `type`, `title`, `subtitle`, `narrative`, `facts`, `created_at`), full-text through `observations_fts`. Rows of type `decision` carry the most signal.
- `session_summaries` (`request`, `learned`, `completed`, `next_steps`, `project`, `created_at`), full-text through `session_summaries_fts`.

```sql
select o.id, o.project, o.type, o.title, substr(o.created_at, 1, 10)
from observations_fts f join observations o on o.id = f.rowid
where observations_fts match '<words>' and o.project = '<repo folder>'
order by bm25(observations_fts) limit 20;
```

**Fleet ledgers**, when the question touches work a coordinator ran. Ledgers sit in session scratchpads: `/tmp/claude-<uid>/<project>/<session>/scratchpad/coordinator/state.json` (the project segment is the repo path with `/` turned into `-`). Live fleets, through the plugin's fleet CLI (`<plugin root>/fleet/bin/fleet`, the plugin root being three directories above the `why` skill's): `fleet fleets list`, then `fleet fleets show <fleet>` and `fleet fleets decision <fleet> <id>`. For any ledger, read its `decisions` directly:

```
python3 -c 'import json,sys; [print(d["id"], d["status"], d.get("closed"), d["title"], "|", d.get("answer"), "|", d.get("resolution")) for d in json.load(open(sys.argv[1])).get("decisions", [])]' <state.json>
```

A decided row (`status: decided`) with its `why`, `answer` and `resolution` records a choice and the reason given for it.

## What good evidence looks like here

- A memo `decision` note naming the target: "Chose X over Y because Z"
- A `gotcha` note describing the trap the target's code avoids
- A claude-mem `decision` observation or session summary whose `learned` field names the choice, dated just before the change
- A ledger decision whose question and answer match the target's shape

## Common pitfalls

- **Narration is not rationale.** Most claude-mem `discovery` and `change` rows retell what a session did; they rarely say why.
- **Superseded notes.** Report the replacement as current and the old note as history.
- **Company data.** Notes and observations from company repos may name clients or cases: report the engineering rationale only, in role terms, citing the note or observation ID.
- **Project names.** claude-mem's `project` is the folder name; the same name in two orgs can mix repos. Check the narrative matches this repo.

## What to return

For each relevant item:
- Store (memo / claude-mem / ledger) and ID (memo `Q4KT23`, claude-mem `#6622`, ledger path and decision id)
- Kind and date
- The line, quoted (paraphrased, for company content)
- Whether it is a deliberate decision record or narration
