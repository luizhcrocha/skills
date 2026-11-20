# Upstream names and ours

The upstream sync (`scripts/sync_upstream.py`, overlay mode) adds to a synced skill's last line every row whose upstream name its text uses, so the verbatim upstream text still points the agent at our skill. One table per upstream; add a row when an upstream text names a skill or file we renamed.

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

## emilkowalski

| Upstream | Ours |
|---|---|
| emil-design-eng | tstack:design-engineering |
| animation-vocabulary | tstack:animate (its naming mode) |
| write-swift | tstack:lang-swift |
| animate-expo | none: React Native is outside tstack |
