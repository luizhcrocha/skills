---
description: "Generate a project-local verify-<app> skill that launches the app and drives it like a user. Use for \"make a verify skill\", or when proving a change means improvising the launch."
disable-model-invocation: ~
---

- Claude Code's `run` skill launches through a project verify skill, so the generated description names "run", "launch", "prove" and "verify". A `.claude/skills/verify-*` already present → `tstack:maintain-verification-skill` instead.
- Web UI: claude-in-chrome (load its tools in one ToolSearch `select:`; click by `find`/`read_page` refs), or Playwright when the proof must re-run unattended. Electron: drive the dev URL in Chrome and name the main-process paths it skips, or `_electron.launch()`.
- Secrets come through the repo's mechanism (`secretspec run --`), never into the skill. A server starts in the background with its pid recorded; cleanup kills that pid and closes the tabs it opened.
- Land it as its own jj change, with the evidence dir (`artifacts/verify/`) in `.gitignore`.
