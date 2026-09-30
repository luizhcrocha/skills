Based on [mattpocock/skills](https://github.com/mattpocock/skills#)
`tuca-mode`, its playbooks and watch-pr, the `principles`, `how`, `why` and `explain` are adapted from poteto's [pstack](https://github.com/cursor/plugins/tree/main/pstack), MIT.
Just feel I will change this a lot throug time.

# Skills for dev work

[![skills.sh](https://skills.sh/b/luizhcrocha/skills)](https://skills.sh/luizhcrocha/skills)

My agent skills that I use work on mine and company projects.

Trial and error to see what really useful.

## Quickstart (30-second setup)

1. Install the **tstack** plugin in Claude Code (from a local checkout: `claude plugin marketplace add ~/repos/luizhcrocha/skills`):

```
/plugin marketplace add luizhcrocha/skills
/plugin install tstack@tstack
```

   Other agents (Codex, Cursor, …) still install through skills.sh: `npx skills@latest add luizhcrocha/skills`. Don't pick Claude Code there, or every skill shows up twice.

2. After editing a skill, bump `version` in `.claude-plugin/plugin.json` and run `claude plugin update tstack@tstack`: the plugin is served from a versioned cache, not from the checkout. The restructure in progress is described in [docs/tstack-plan.md](docs/tstack-plan.md).

3. Run `/setup-luizrocha-skills` in your agent. It will:
   - Ask you which issue tracker you want to use (GitHub, Linear, or local files)
   - Ask you what labels you apply to tickets when you triage them (`/triage` uses labels)
   - Ask you where you want to save any docs we create

4. Bam - you're ready to go.

## Why These Skills Exist

I built these skills as a way to fix common failure modes I see with Claude Code, Codex, and other coding agents.

### #1: The Agent Didn't Do What I Want

> "No-one knows exactly what they want"
>
> David Thomas & Andrew Hunt, [The Pragmatic Programmer](https://www.amazon.co.uk/Pragmatic-Programmer-Anniversary-Journey-Mastery/dp/B0833F1T3V)

**The Problem**. The most common failure mode in software development is misalignment. You think the dev knows what you want. Then you see what they've built - and you realize it didn't understand you at all.

This is just the same in the AI age. There is a communication gap between you and the agent. The fix for this is a **grilling session** - getting the agent to ask you detailed questions about what you're building.

**The Fix** is to use:

- [`/grill-me`](./skills/productivity/grill-me/SKILL.md) - for non-code uses
- [`/grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md) - same as [`/grill-me`](./skills/productivity/grill-me/SKILL.md), but adds more goodies (see below)

These are my most popular skills. They help you align with the agent before you get started, and think deeply about the change you're making. Use them _every_ time you want to make a change.

### #2: The Agent Is Way Too Verbose

> With a ubiquitous language, conversations among developers and expressions of the code are all derived from the same domain model.
>
> Eric Evans, [Domain-Driven-Design](https://www.amazon.co.uk/Domain-Driven-Design-Tackling-Complexity-Software/dp/0321125215)

**The Problem**: At the start of a project, devs and the people they're building the software for (the domain experts) are usually speaking different languages.

I felt the same tension with my agents. Agents are usually dropped into a project and asked to figure out the jargon as they go. So they use 20 words where 1 will do.

**The Fix** for this is a shared language. It's a document that helps agents decode the jargon used in the project.

This is built into [`/grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md). It's a grilling session, but that helps you build a shared language with the AI, and document hard-to-explain decisions in ADR's.

It's hard to explain how powerful this is. It might be the single coolest technique in this repo. Try it, and see.

> [!TIP]
> A shared language has many other benefits than reducing verbosity:
>
> - **Variables, functions and files are named consistently**, using the shared language
> - As a result, the **codebase is easier to navigate** for the agent
> - The agent also **spends fewer tokens on thinking**, because it has access to a more concise language

### #3: The Code Doesn't Work

> "Always take small, deliberate steps. The rate of feedback is your speed limit. Never take on a task that’s too big."
>
> David Thomas & Andrew Hunt, [The Pragmatic Programmer](https://www.amazon.co.uk/Pragmatic-Programmer-Anniversary-Journey-Mastery/dp/B0833F1T3V)

**The Problem**: Let's say that you and the agent are aligned on what to build. What happens when the agent _still_ produces crap?

It's time to look at your feedback loops. Without feedback on how the code it produces actually runs, the agent will be flying blind.

**The Fix**: You need the usual tranche of feedback loops: static types, browser access, and automated tests.

For automated tests, a red-green-refactor loop is critical. This is where the agent writes a failing test first, then fixes the test. This helps give the agent a consistent level of feedback that results in far better code.

I've built a **[`/tdd`](./skills/engineering/tdd/SKILL.md) skill** you can slot into any project. It picks the evidence a change needs from a testing ladder (examples, integration, property, model-based, fuzzing, mutation, deterministic simulation), runs red-green in vertical slices, and gives the agent plenty of guidance on what makes good and bad tests.

For debugging, I've also built a **[`/diagnosing-bugs`](./skills/engineering/diagnosing-bugs/SKILL.md)** skill that wraps best debugging practices into a disciplined loop, gated phase by phase.

### #4: We Built A Ball Of Mud

> "Invest in the design of the system _every day_."
>
> Kent Beck, [Extreme Programming Explained](https://www.amazon.co.uk/Extreme-Programming-Explained-Embrace-Change/dp/0321278658)

> "The best modules are deep. They allow a lot of functionality to be accessed through a simple interface."
>
> John Ousterhout, [A Philosophy Of Software Design](https://www.amazon.co.uk/Philosophy-Software-Design-2nd/dp/173210221X)

**The Problem**: Most apps built with agents are complex and hard to change. Because agents can radically speed up coding, they also accelerate software entropy. Codebases get more complex at an unprecedented rate.

**The Fix** for this is a radical new approach to AI-powered development: caring about the design of the code.

This is built in to every layer of these skills:

- [`/to-spec`](./skills/engineering/to-spec/SKILL.md) quizzes you about which seams you're touching before creating a spec
- [`/how`](./skills/engineering/how/SKILL.md) explains code in the context of the whole system

And crucially, [`/improve-codebase-architecture`](./skills/engineering/improve-codebase-architecture/SKILL.md) helps you rescue a codebase that has become a ball of mud. I recommend running it on your codebase once every few days.

### Summary

Software engineering fundamentals matter more than ever. These skills are my best effort at condensing these fundamentals into repeatable practices, to help you ship the best apps of your career. Enjoy.

## Reference

### Engineering

Skills I use daily for code work.

- **[diagnosing-bugs](./skills/engineering/diagnosing-bugs/SKILL.md)** — Disciplined diagnosis loop for hard bugs and performance regressions: build a feedback loop that goes red on this bug → minimise → hypothesise → instrument → fix → regression-test.
- **[grill-with-docs](./skills/engineering/grill-with-docs/SKILL.md)** — Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates `CONTEXT.md` and ADRs inline.
- **[triage](./skills/engineering/triage/SKILL.md)** — Triage issues through a state machine of triage roles.
- **[improve-codebase-architecture](./skills/engineering/improve-codebase-architecture/SKILL.md)** — Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
- **[codebase-design](./skills/engineering/codebase-design/SKILL.md)** — Shared vocabulary and principles for designing deep modules — module, interface, depth, seam, adapter, leverage, locality — used directly or pulled in by other skills.
- **[domain-modeling](./skills/engineering/domain-modeling/SKILL.md)** — Actively build and sharpen a project's domain model: challenge fuzzy terms, capture the glossary in `CONTEXT.md`, and record hard-to-reverse decisions as ADRs inline.
- **[setup-luizrocha-skills](./skills/engineering/setup-luizrocha-skills/SKILL.md)** — Scaffold the per-repo config (issue tracker, triage label vocabulary, domain doc layout) that the other engineering skills consume. Run once per repo before using `to-issues`, `to-spec`, `triage`, `diagnosing-bugs`, `code-review`, `tdd`, or `improve-codebase-architecture`.
- **[research](./skills/engineering/research/SKILL.md)** — Investigate a question against high-trust primary sources and capture the findings as a cited Markdown file in the repo, run as a background agent.
- **[resolving-merge-conflicts](./skills/engineering/resolving-merge-conflicts/SKILL.md)** — Work through an in-progress git merge or rebase conflict hunk by hunk, resolving by intent traced to each side's primary source, then finish the operation (never `--abort`).
- **[tdd](./skills/engineering/tdd/SKILL.md)** — Test-driven development and choosing the evidence: pick the rung of the testing ladder the risk needs, then red-green one vertical slice at a time, with substitutes only through seams and the evidence tier reported.
- **[implement](./skills/engineering/implement/SKILL.md)** — Build the work described by a spec or set of issues, driving `/tdd` at pre-agreed seams and closing out with `/code-review` before committing.
- **[code-review](./skills/engineering/code-review/SKILL.md)** — Two-axis review of the diff since a fixed point: **Standards** (does it follow the repo's coding standards, plus `coding-standards-ts` for TypeScript?) and **Spec** (does it faithfully implement the originating issue/spec?), run as parallel sub-agents so neither pollutes the other.
- **[to-issues](./skills/engineering/to-issues/SKILL.md)** — Break any plan, spec, or PRD into independently-grabbable GitHub issues using vertical slices.
- **[to-spec](./skills/engineering/to-spec/SKILL.md)** — Turn the current conversation into a spec and publish it to the issue tracker. No interview, just synthesizes what you've already discussed.
- **[wizard](./skills/engineering/wizard/SKILL.md)** — Generate an interactive bash wizard that walks a human through steps only they can perform: provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover.
- **[how](./skills/engineering/how/SKILL.md)** — Explain how code works at the level of a senior engineer onboarding onto a subsystem: Sonnet explorers map it in parallel, an explainer writes Overview, Key Concepts, How It Works, Where Things Live and Gotchas, and the gotchas become memo notes. Also the "zoom out" map of an unfamiliar area. Adapted from poteto's pstack.
- **[no-comments](./skills/engineering/no-comments/SKILL.md)** — Strip narrating comments from a diff through Comment Sicko, a comment-hating reviewer who didn't write them; fix what they papered over at the root, and offer to encode claimed constraints as types, tests or lints. Land runs it before the worktree-janitor. Adapted from poteto's pstack.
- **[why](./skills/engineering/why/SKILL.md)** — Find out why code is the way it is: a jj code anchor, then one Sonnet investigator per evidence category in parallel (source control, issue tracker, docs, chat, observability, errors, analytics, agent memory), and an Opus synthesizer that writes a cited, confidence-tiered answer with the gaps named, plus Preserve / Change / Avoid / Risk before a change. Company sources yield engineering rationale only. Adapted from poteto's pstack.
- **[explain](./skills/engineering/explain/SKILL.md)** — Explain a change, PR or subsystem plainly so you understand it now: `how` and `why` do the digging, and one conversational account comes back, definition first, smallest complete answer, diagrams built up one part at a time. Adapted from poteto's pstack (its `teach`).
- **[prototype](./skills/engineering/prototype/SKILL.md)** — Build a throwaway prototype to answer a design question — either a single shareable HTML file for state/logic questions, or several radically different UI variations toggleable from one route.
- **[coding-standards-ts](./skills/engineering/coding-standards-ts/SKILL.md)** — TypeScript coding standards and design taste: correctness first, precise domain modeling, typed failures, deep modules, explicit boundaries, real-seam tests, with topic files for Effect and Cloudflare.
- **[worktree-janitor](./skills/engineering/worktree-janitor/SKILL.md)** — Shape a messy jj `@` into a clean, described stack through the worktree-janitor agent (split by intent down to single hunks with `jj-hunk-pick`, fixups absorbed, conflicts resolved, messages in the repo's style, empty `@` on top; siblings joined by a merge when asked), then audit it mechanically with `janitor-audit`: same final tree, nothing below the stack touched, one `jj op restore` to undo.
- **[principles](./skills/engineering/principles/SKILL.md)** — Twenty-three engineering principles (laziness, root causes, prove it works, model the domain, guard the context window…), an index of one line each and a file per principle, adapted from poteto's pstack (MIT).
- **[tuca-mode](./skills/engineering/tuca-mode/SKILL.md)** — `/tuca-mode`: the working mode for the rest of the session. Every task is routed to a playbook (bug fix, feature, refactoring, land, workspace prune…) whose steps open the todo list, with the principles, the autonomy and reply rules, and a coordinator's mindset; it survives compactions until "stop tuca-mode". Adapted from poteto's pstack (MIT).

### Productivity

General workflow tools, not code-specific.

- **[coordinator](./skills/productivity/coordinator/SKILL.md)** — Run the session as a coordinator of a fleet of agents: route each task to the right skill (`implement`, `diagnosing-bugs`, `prototype`, `research`, `tdd`), brief workers with lanes, completion criteria, and the `codebase-design` rules that `improve-codebase-architecture` enforces, track them in a live dashboard served over your tailnet, built for a phone: one list of the decisions that wait on you, each with a page built for deciding, the roadmap and roadblocks, per-worker token usage, and a chat where you write to the coordinator or `@`-mention any worker.
- **[manager](./skills/productivity/manager/SKILL.md)** — Run the session as the manager of every coordinator on the machine: one queue for landings and deploys, answers to what a fleet asks from what the others already know, only what is yours passed on to you, and a page over your tailnet that shows every fleet and everything that waits on you across them.
- **[memo](./skills/productivity/memo/SKILL.md)** — Durable memory for every session in a repo: deliberate one-line notes (decisions, gotchas, preferences, open threads) kept in `.tstack/memo/`, a bounded wake injected at session start, supersede and pins, and the compaction tasks that keep the wake small.
- **[recall](./skills/productivity/recall/SKILL.md)** — Answer what we know or what happened before from memo's notes, `jj log`, and the archived claude-mem database (read-only), as a short cited answer.
- **[unslop](./skills/productivity/unslop/SKILL.md)** — Cut AI tells from prose that ships (docs, commit and PR messages, READMEs, skill text, memo notes, replies under /tuca-mode): about thirty numbered rules other skills cite. Adapted from poteto's pstack.
- **[technical-writing](./skills/productivity/technical-writing/SKILL.md)** — Layered standard for documents people read: pick the Diátaxis mode, then Google developer style, STE instruction rules and Global English. Adapted from poteto's pstack.
- **[grill-me](./skills/productivity/grill-me/SKILL.md)** — Get relentlessly interviewed about a plan or design until every branch of the decision tree is resolved.
- **[grilling](./skills/productivity/grilling/SKILL.md)** — Get interviewed relentlessly, one question at a time, down every branch of the decision tree until you reach shared understanding. The engine behind `grill-me`, `grill-with-docs`, `triage` and `improve-codebase-architecture`.
- **[handoff](./skills/productivity/handoff/SKILL.md)** — Compact the current conversation into a handoff document so another agent can continue the work.
- **[orchestrate](./skills/productivity/orchestrate/SKILL.md)** — Fan a batch of pending tasks out across subagents, a dynamic workflow, or an agent team, partitioned by file ownership so workers never conflict, with shared coding standards baked into every worker prompt.
- **[show-me](./skills/productivity/show-me/SKILL.md)** — Explain the current topic visually with the smallest view that makes the point: pseudocode, call trees, component trees, file trees, Mermaid diagrams, diffs, or a focused HTML artifact.
- **[teach](./skills/productivity/teach/SKILL.md)** — Teach a new skill or concept over multiple sessions using a stateful teaching workspace grounded in a mission, trusted resources, learning records, and a glossary.
- **[wait-what](./skills/productivity/wait-what/SKILL.md)** — Fire this the moment a message doesn't land. The agent re-pitches it with the context you're missing, in plain English, using your `CONTEXT.md` vocabulary.
- **[writing-for-agents](./skills/productivity/writing-for-agents/SKILL.md)** — Writing documents for agents: skills, AGENTS.md/CLAUDE.md, and any doc an agent reaches by a pointer.

### Misc

Tools I keep around but rarely use.

- **[git-guardrails-claude-code](./skills/misc/git-guardrails-claude-code/SKILL.md)** — Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, etc.) before they execute.
- **[migrate-to-shoehorn](./skills/misc/migrate-to-shoehorn/SKILL.md)** — Migrate test files from `as` type assertions to @total-typescript/shoehorn.
- **[scaffold-exercises](./skills/misc/scaffold-exercises/SKILL.md)** — Create exercise directory structures with sections, problems, solutions, and explainers.
- **[setup-pre-commit](./skills/misc/setup-pre-commit/SKILL.md)** — Set up Husky pre-commit hooks with lint-staged, Prettier, type checking, and tests.
