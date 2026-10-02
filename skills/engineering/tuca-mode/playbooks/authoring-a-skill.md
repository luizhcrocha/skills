# Authoring a skill

**You own the skill's voice.** Covers a SKILL.md, a playbook, an `AGENTS.md` or `CLAUDE.md`: any document an agent consumes. A repo's instructions go in `AGENTS.md`; never add a `CLAUDE.md` beside one, since it hides `AGENTS.md` from Claude (`/migrate-to-agents-md` moves an old one).

1. Load `tstack:writing-for-agents` and, for a skill, its SKILL-MECHANICS.md. Decide the invocation first (model-invoked with a trigger description, or user-invoked with a human-facing one), then place each piece on the information hierarchy: steps in the file, reference in the file or disclosed behind a pointer.
2. Write it. Every step ends on a completion criterion; leading words over restated triads; the positive target over a prohibition; delete a sentence that does not change behaviour against the default. Point at structural sources (types, READMEs, config, `--help`) instead of restating them (Encode Lessons in Structure). Delegate to other skills by name; cite only skills tstack has (`.claude-plugin/plugin.json`).
3. Validate: frontmatter has `name` and `description`; every referenced file exists; every cross-skill name resolves. In tstack, the repo invariants hold (`CLAUDE.md` or `AGENTS.md`: the skill is in `plugin.json`, the top-level `README.md` and its bucket README), `just validate` passes, and a model-invoked description's always-on cost is measured.
4. Test it when the behaviour is structural: one real run (`claude -p` on the skill, a throwaway repo) or the Eval playbook for a change whose effect is uncertain. Skip for a purely wording change, and say so.
5. Run the Land playbook.

A workflow you keep hitting that no skill captures → propose a new skill. When in doubt, delete.

**Reply:** what the skill does, its invocation and why, the key design decisions, validation and test notes.
