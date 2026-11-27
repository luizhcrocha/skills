# Upstream names and ours

The upstream sync (`scripts/sync_upstream.py`, overlay mode) adds to a synced skill's last line every row whose upstream name its text uses, so the verbatim upstream text still points the agent at our skill. One table per upstream, plus `everywhere` for names any upstream may use; add a row when an upstream text names a skill or file we renamed.

## mattpocock

| Upstream | Ours |
|---|---|
| code-review | none: tstack dropped its review skill (Luiz, 2026-11-20) |
| codebase-design | none: tstack dropped it (Luiz, 2026-11-20); the terms the text lists are enough |
| GLOSSARY.md | CONTEXT.md |
| GLOSSARY-MAP.md | CONTEXT-MAP.md |
| setup-matt-pocock-skills | tstack:setup-luizrocha-skills |
| zoom-out | tstack:how |

## pstack

| Upstream | Ours |
|---|---|
| poteto-mode | tstack:tuca-mode |
| typescript-best-practices | tstack:lang-ts |
| pstack-models.mdc | docs/models.md (roles) |
| generalPurpose | general-purpose |
| AskQuestion | AskUserQuestion |
| create-skill | none: tstack dropped writing-for-agents (Luiz, 2026-11-20) |
| /visualize | none: tstack dropped show-me (Luiz, 2026-11-20) |
| principle-fix-root-causes | tstack:principles |
| principle-redesign-from-first-principles | tstack:principles |
| redesign-from-first-principles | tstack:principles |
| encode-lessons-in-structure | tstack:principles |
| foundational-thinking | tstack:principles |
| laziness-protocol | tstack:principles |
| never-block-on-the-human | tstack:principles |
| prove-it-works | tstack:principles |
| separate-before-serializing-shared-state | tstack:principles |
| sequence-verifiable-units | tstack:principles |
| .cursor/skills | .claude/skills |
| poteto-agent | tstack:tuca-agent |
| Task tool | the Agent tool |
| Task subagent | an Agent subagent |
| Task spawn | an Agent spawn |
| todolist tool | TodoWrite or TaskCreate (ToolSearch loads them) |
| setup-pstack | none: models come from docs/models.md |
| Opening a PR | tuca-mode's Land (local/tuca-mode/land.md); a PR only when Luiz asks, then this playbook |
| opening-a-pr.md | local/tuca-mode/land.md, unless Luiz asked for a PR |
| worktree-cleanup | local/tuca-mode/workspace-prune.md (jj workspaces) |
| Worktree cleanup | local/tuca-mode/workspace-prune.md (jj workspaces) |
| worktree-audit.sh | none: jj workspaces, see local/tuca-mode/workspace-prune.md |
| /deslop | tstack:deslop |
| cursor-team-kit | none: tstack takes only deslop from it |
| control-ui | the repo's verify-<app> skill (tstack:create-verification-skill), else picasso or claude-in-chrome |
| control-cli | a Rex tab (`fleet tab run`) or a background Bash call |
| Cursor cloud agent | a background Agent in its own jj workspace |
| operator | Luiz |
| claude-opus-5-5-xhigh-fast | the role's model and effort in docs/models.md |
| claude-opus-5-5-high-fast | the role's model and effort in docs/models.md |
| claude-opus-5-5-medium-fast | the role's model and effort in docs/models.md |
| claude-fable-5-2-high | the Reviewer row in docs/models.md: never Fable for fan-out |
| gemini-4-neon-xhigh | none: a panel seat on another vendor is skipped |
| principle-build-the-lever | tstack:principles |
| principle-encode-lessons-in-structure | tstack:principles |
| principle-guard-the-context-window | tstack:principles |
| principle-prove-it-works | tstack:principles |

## emilkowalski

| Upstream | Ours |
|---|---|
| emil-design-eng | tstack:design-engineering |
| animation-vocabulary | tstack:animate (its naming mode) |
| write-swift | tstack:lang-swift |
| animate-expo | none: React Native is outside tstack |

## everywhere

| Upstream | Ours |
|---|---|
| ADR | none: tstack keeps no ADRs (Luiz, 2026-11-20); a decision goes to memo or the change's description |
| ADRs | none: tstack keeps no ADRs (Luiz, 2026-11-20); a decision goes to memo or the change's description |
| docs/adr | none: tstack keeps no ADRs (Luiz, 2026-11-20); a decision goes to memo or the change's description |
