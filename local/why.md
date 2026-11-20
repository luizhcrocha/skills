---
description: "Find why code is the way it is. Use for \"why does X work this way\", \"why did we pick Y\", regressions, postmortems, or before changing unexplained code."
disable-model-invocation: ~
---

- The record is jj: `jj log -r '::@' -- <path>`, `jj file annotate <path>`, `jj show <change>`, `jj log -r 'description(substring-i:"<word>")'`. PRs: `gh pr list --search <sha> --state all` and `gh pr view <n>`, run from the main workspace (a secondary jj workspace has no `.git`).
- When the trail is thin: the repo's docs and `CONTEXT.md`, memo (`tstack:recall`), then the issue tracker, chat and observability servers this session has, each searched by its own Researcher agent ([models.md](../docs/models.md)) in parallel. A source that needs a login or failed to connect is named, never waited on.
- Company sources stay at engineering rationale: no client names, case details, personal data or document contents in the answer.
- A durable rationale nobody wrote down becomes a memo note (`tstack:memo`).
