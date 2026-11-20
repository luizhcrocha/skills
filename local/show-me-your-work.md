---
description: "Keep a reviewable decision log (what, why, evidence, result) for long or unattended work, audited before hand-back. Use for autonomous runs, hillclimbs, bespoke playbooks."
disable-model-invocation: ~
---

- Evidence is a jj change id; a dropped attempt's result is `abandoned`.
- The log lives in the session's scratchpad (`decisions.tsv`); a committed one is `.audit/<task-slug>.tsv` in its own jj change on top of the work.
- This run's transcript: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sessions.py path ${CLAUDE_SESSION_ID}`. A `start` row's evidence is `session ${CLAUDE_SESSION_ID}`.
- The reviewer is a fresh-context agent ([models.md](../docs/models.md)), the Decider after a long absence, else a Reviewer; its line reads `reviewed by <model>, fresh context`.
