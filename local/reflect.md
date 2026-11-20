---
description: Mine this session's transcript for durable learnings through three reviewers and a synthesizer, then land the approved skill edits as a jj change in the tstack repo, the approved facts as memo notes and the approved backlog rows as issues.
---

- This session's transcript: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sessions.py path ${CLAUDE_SESSION_ID}` (`sessions.py digest <path>` for a timeline). Never read another project's transcripts. A long one goes to Reviewer agents ([models.md](../docs/models.md)), not the main thread.
- Besides skill edits: a durable project fact becomes a memo note (`tstack:memo`); an approved backlog row goes to `tstack:lint-evolve` when it is a lint, else becomes an issue (`tstack:to-issues`).
- Skill edits land as one jj change in the repo that owns the skill, in a workspace of their own (tstack: `cd ~/repos/luizhcrocha/skills; ws-add reflect -r 'trunk()'`). Run `just test-changed`, describe the change, `jj new`. Never push or move a bookmark.
