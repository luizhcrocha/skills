# Agent Memory (memo, the claude-mem archive, fleet ledgers)

## What this source contains

What earlier agent sessions learned and decided, often the only record of a decision made in a session that never reached a doc.

- **memo**: deliberate one-line notes of knowledge (a choice and its reason, a trap, a preference, a fact), each in one scope: a repository, a machine, a group of repositories, or the user. The stores live outside every checkout. Summaries quote the notes they keep. Notes from before memo v2 also carry a kind (`decision`, `gotcha`, `preference`, `fact`, `open`), and an old summary has a rewritten line of its own.
- **The claude-mem archive**: automatic observations and session summaries from before memo (archived 2026-09-30, read-only).
- **Fleet ledgers**: the `state.json` of coordinator sessions, whose `decisions` hold questions put to Luiz with the options, his answer and how it was resolved.

A memo note that states a choice and its reason is written on purpose: close to Direct evidence. An old summary's rewritten line is a model's paraphrase: check it against the notes it covers (`memo zoom`). claude-mem observations are machine narration: treat them as circumstantial unless one quotes the user or a decision.

## How to search it

Read only. Never write a note, open the archive writable, or run a state command that changes a ledger.

**memo** (on the Bash PATH through the tstack plugin):

```
memo recall <words>          # the stores this session reads
memo recall <words> --all    # every store on this machine
memo zoom <ID>               # what a summary covers
```

A superseded or retired note is history: report it with what replaced it or why it was retired, and the newer note as current. Notes written before memo v2 sit in the repo's history up to the change that removed `.tstack/memo/` (`jj log -r '::@' -- .tstack/memo`), and the change that added such a note usually carries the work it came from.

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

**Fleet ledgers**, when the question touches work a coordinator ran. Ledgers sit in session scratchpads: `/tmp/claude-<uid>/<project>/<session>/scratchpad/coordinator/state.json` (the project segment is the repo path with `/` turned into `-`). Live fleets, through the fleet CLI when `fleet` is on PATH: `fleet ls`, then `fleet ls <fleet>` and `fleet card <fleet> <id>`. For any ledger, read its `decisions` directly:

```
python3 -c 'import json,sys; [print(d["id"], d["status"], d.get("closed"), d["title"], "|", d.get("answer"), "|", d.get("resolution")) for d in json.load(open(sys.argv[1])).get("decisions", [])]' <state.json>
```

A decided row (`status: decided`) with its `why`, `answer` and `resolution` records a choice and the reason given for it.

## What good evidence looks like here

- A memo note naming the target: "Chose X over Y because Z"
- A memo note describing the trap the target's code avoids
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
- Scope (memo), kind (claude-mem, or an old memo note) and date
- The line, quoted (paraphrased, for company content)
- Whether it is a deliberate decision record or narration
