# Engineering

Skills I use daily for code work.

- **[diagnosing-bugs](./diagnosing-bugs/SKILL.md)** — Disciplined diagnosis loop for hard bugs and performance regressions: build a feedback loop that goes red on this bug → minimise → hypothesise → instrument → fix → regression-test.
- **[grill-with-docs](./grill-with-docs/SKILL.md)** — Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates `CONTEXT.md` and ADRs inline.
- **[triage](./triage/SKILL.md)** — Triage issues through a state machine of triage roles.
- **[improve-codebase-architecture](./improve-codebase-architecture/SKILL.md)** — Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
- **[codebase-design](./codebase-design/SKILL.md)** — Shared vocabulary and principles for designing deep modules — module, interface, depth, seam, adapter, leverage, locality — used directly or pulled in by other skills.
- **[domain-modeling](./domain-modeling/SKILL.md)** — Actively build and sharpen a project's domain model: challenge fuzzy terms, capture the glossary in `CONTEXT.md`, and record hard-to-reverse decisions as ADRs inline.
- **[setup-luizrocha-skills](./setup-luizrocha-skills/SKILL.md)** — Scaffold the per-repo config (issue tracker, triage label vocabulary, domain doc layout) that the other engineering skills consume. Run once per repo before using `to-issues`, `to-spec`, `triage`, `diagnosing-bugs`, `code-review`, `tdd`, `improve-codebase-architecture`, or `zoom-out`.
- **[research](./research/SKILL.md)** — Investigate a question against high-trust primary sources and capture the findings as a cited Markdown file in the repo, run as a background agent.
- **[resolving-merge-conflicts](./resolving-merge-conflicts/SKILL.md)** — Work through an in-progress git merge or rebase conflict hunk by hunk, resolving by intent traced to each side's primary source, then finish the operation (never `--abort`).
- **[tdd](./tdd/SKILL.md)** — Test-driven development with a red-green-refactor loop. Builds features or fixes bugs one vertical slice at a time.
- **[implement](./implement/SKILL.md)** — Build the work described by a spec or set of issues, driving `/tdd` at pre-agreed seams and closing out with `/code-review` before committing.
- **[code-review](./code-review/SKILL.md)** — Two-axis review of the diff since a fixed point: **Standards** (does it follow the repo's coding standards, plus `coding-standards-ts` for TypeScript?) and **Spec** (does it faithfully implement the originating issue/spec?), run as parallel sub-agents so neither pollutes the other.
- **[to-issues](./to-issues/SKILL.md)** — Break any plan, spec, or PRD into independently-grabbable GitHub issues using vertical slices.
- **[to-spec](./to-spec/SKILL.md)** — Turn the current conversation into a spec and publish it to the issue tracker. No interview, just synthesizes what you've already discussed.
- **[wizard](./wizard/SKILL.md)** — Generate an interactive bash wizard that walks a human through steps only they can perform: provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover.
- **[zoom-out](./zoom-out/SKILL.md)** — Tell the agent to zoom out and give broader context or a higher-level perspective on an unfamiliar section of code.
- **[prototype](./prototype/SKILL.md)** — Build a throwaway prototype to answer a design question — either a single shareable HTML file for state/logic questions, or several radically different UI variations toggleable from one route.
- **[coding-standards-ts](./coding-standards-ts/SKILL.md)** — TypeScript coding standards and design taste: correctness first, precise domain modeling, typed failures, deep modules, explicit boundaries, real-seam tests, with topic files for Effect and Cloudflare.
- **[worktree-janitor](./worktree-janitor/SKILL.md)** — Shape a messy jj `@` into a clean, described stack through the worktree-janitor agent (split by intent, fixups absorbed, conflicts resolved, messages in the repo's style, empty `@` on top), then audit it mechanically with `janitor-audit`: same final tree, nothing below the stack touched, one `jj op restore` to undo.
