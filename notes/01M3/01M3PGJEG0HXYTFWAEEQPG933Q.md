+++
id = "01M3PGJEG0HXYTFWAEEQPG933Q"
kind = "decision"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-29T12:00:00Z"
refs = ["claude-mem:sum:2798", "claude-mem:sum:2942", "claude-mem:sum:2794", "claude-mem:sum:3613"]
+++
Fleet state has one writer, the state CLI (state.py): one command per event validates, stamps and renders (--no-render batches). Models never hand-edit state.json (the main failure); a subagent for bookkeeping costs more than the ~200-400 token command.
