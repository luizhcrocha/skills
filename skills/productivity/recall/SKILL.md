---
name: recall
description: Answer what we know or what happened before, from memo, jj log and the archived claude-mem database. Use when asked about earlier sessions, past decisions, or whether something was already done.
---

Answer from the record, not from memory: search each source below that bears on the question, then reply with a short answer where every claim cites its source. Never paste raw dumps into the conversation.

## Sources, in order

1. **memo**, the deliberate notes and summaries. `memo recall <words>` searches the project and global stores (`--all`: every repo indexed on this machine); `memo zoom <ID>` expands a summary into what it covers. A result marked `superseded by` is history: cite the note that replaced it.
2. **`jj log`**: descriptions carry the why of each change. Search them with a revset, e.g. `jj log -r 'description(substring-i:"hook")' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'`; `jj show <change>` for one change. In a plain git repo, `git log --grep=<word> -i --oneline`.
3. **claude-mem archive**, the automatic observations of sessions before memo, when the file exists (`~/.claude-mem/claude-mem.db`, or wherever it was archived). Open it **read-only** and never write to it:

   ```
   sqlite3 'file:/home/luizrocha/.claude-mem/claude-mem.db?mode=ro' "<query>"
   ```

   - `observations` (`id`, `project` = the repo folder's name, `type`, `title`, `subtitle`, `narrative`, `facts`, `created_at`), full-text through `observations_fts`. Rows of type `decision` carry the most signal; most `discovery` and `change` rows are narration.
   - `session_summaries` (`request`, `learned`, `completed`, `next_steps`, `project`, `created_at`), full-text through `session_summaries_fts`.

   ```sql
   select o.id, o.project, o.type, o.title, substr(o.created_at, 1, 10)
   from observations_fts f join observations o on o.id = f.rowid
   where observations_fts match 'jj workspace' and o.project = 'skills'
   order by bm25(observations_fts) limit 10;
   ```
4. **Fleet ledgers**, when the question is about work a coordinator ran: the ledger files under the coordinator's state directory.

## The answer

A few lines: what is known, then the citations (`memo Q4KT23`, `jj kxqmrvop`, `claude-mem #6622 (2026-07-25)`). Say plainly when the sources disagree (the newer one usually wins; say which) or when nothing was found. If the answer is a durable lesson that memo lacks, offer to note it.
