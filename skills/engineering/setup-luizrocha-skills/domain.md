# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **Past decisions** — memo notes (`memo recall`) and change descriptions (`jj log -- <path>`) for the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
└── src/
    ├── ordering/
    │   └── CONTEXT.md
    └── billing/
        └── CONTEXT.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag decision conflicts

If your output contradicts a recorded decision (a memo note, a change's description), surface it explicitly rather than silently overriding:

> _Contradicts the memo note on event-sourced orders — but worth reopening because…_
