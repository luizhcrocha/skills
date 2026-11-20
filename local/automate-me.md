---
description: Refresh /tuca-mode from how Luiz actually works, mined from his recent Claude Code transcripts, as jj changes for him to review.
argument-hint: "[projects to mine] [since YYYY-MM-DD]"
---

- There is one mode, `tuca-mode`: refresh it, never create another `-mode` skill.
- Transcripts are Claude Code's; `${CLAUDE_PLUGIN_ROOT}/scripts/human-turns --project <path> --workspaces --since <date>` prints Luiz's own turns (`--list` counts them). The window defaults to the last change to tuca-mode. Never read another project's transcripts.
- Miners are `tstack:reader` agents ([models.md](../docs/models.md)), one per batch of about 150 turns. Paraphrase: no client, person or case names.
- Homes for a rule: the global `CLAUDE.md` in dotfiles, `tuca-mode/SKILL.md`, one of its playbooks, a repo's `AGENTS.md`, or a structure proposal (a lint goes through `tstack:lint-evolve`).
- Ask Luiz in the chat, a numbered list of the kept rules, not a question dialog.
- Land as jj changes for review: `ws-add automate-me -r master` in tstack, `-r nix` in dotfiles. No push.
