---
description: "Answer from the record what we knew, did or decided, or catch Luiz up. Use for \"what do we know about X\" or \"where did I leave off\"."
argument-hint: "[what do we know about X | catch me up (on X) (last N days)]"
disable-model-invocation: ~
---

- A second mode, Lookup ("what do we know about X", "did we decide Y"): search memo (`memo recall <words>`, `memo zoom <id>`), tape (`tape build`, `tape search <words>`, `tape zoom <id>`), `jj log -r 'description(substring-i:"<word>")'`, the read-only claude-mem archive (`sqlite3 "file:$HOME/.local/share/claude-mem-archive/claude-mem.db?mode=ro"`) and fleet ledgers, then answer in a few lines with every claim cited.
- Transcripts are Claude Code's: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sessions.py list --days <N> --exclude ${CLAUDE_SESSION_ID}` lists this project's, `sessions.py digest <path>` reduces one. Never read another project's.
- Start a catch-up from `tape search <topic>`; mine only what tape leaves unanswered, with `tstack:reader` agents ([models.md](../docs/models.md)) over batches of about 1 MB.
- The shared-record sweep is the `why` skill's investigators, for the issue tracker, chat, errors and observability only.
- Live state: `jj log -r 'trunk()..'`, `jj st`, `gh pr list --author @me` (from the main workspace), `fleet waiting`. Status tags: `[landed <change>]` (in `trunk()`), `[pushed]`, `[in flight <change or workspace>]`, `[open PR #N]`, `[abandoned <change>]`, `[planned, not started]`.
- Resuming one session is tuca-mode's session-pickup playbook.
