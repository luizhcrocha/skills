# Productivity

General workflow tools, not code-specific.

- **[coordinator](./coordinator/SKILL.md)** — Run the session as a coordinator of a fleet of agents: route each task to the right skill (`implement`, `diagnosing-bugs`, `prototype`, `research`, `tdd`), brief workers with lanes, completion criteria, and the `codebase-design` rules that `improve-codebase-architecture` enforces, track them in a live dashboard served over your tailnet, built for a phone: one list of the decisions that wait on you, each with a page built for deciding, the roadmap and roadblocks, per-worker token usage, and a chat where you write to the coordinator or `@`-mention any worker.
- **[manager](./manager/SKILL.md)** — Run the session as the manager of every coordinator on the machine: one queue for landings and deploys, answers to what a fleet asks from what the others already know, only what is yours passed on to you, and a page over your tailnet that shows every fleet and everything that waits on you across them.
- **[memo](./memo/SKILL.md)** — Durable memory for every session in a repo: deliberate one-line notes (decisions, gotchas, preferences, open threads) kept in `.tstack/memo/`, a bounded wake injected at session start, supersede and pins, and the compaction tasks that keep the wake small.
- **[recall](./recall/SKILL.md)** — Answer what we know or what happened before from memo's notes, `jj log`, and the archived claude-mem database (read-only), as a short cited answer.
- **[unslop](./unslop/SKILL.md)** — Cut AI tells from prose that ships (docs, commit and PR messages, READMEs, skill text, memo notes, replies under /tuca-mode): about thirty numbered rules other skills cite. Adapted from poteto's pstack.
- **[technical-writing](./technical-writing/SKILL.md)** — Layered standard for documents people read: pick the Diátaxis mode, then Google developer style, STE instruction rules and Global English. Adapted from poteto's pstack.
- **[grill-me](./grill-me/SKILL.md)** — Get relentlessly interviewed about a plan or design until every branch of the decision tree is resolved.
- **[grilling](./grilling/SKILL.md)** — Get interviewed relentlessly, one question at a time, down every branch of the decision tree until you reach shared understanding. The engine behind `grill-me`, `grill-with-docs`, `triage` and `improve-codebase-architecture`.
- **[handoff](./handoff/SKILL.md)** — Compact the current conversation into a handoff document so another agent can continue the work.
- **[orchestrate](./orchestrate/SKILL.md)** — Fan a batch of pending tasks out across subagents, a dynamic workflow, or an agent team, partitioned by file ownership so workers never conflict, with shared coding standards baked into every worker prompt.
- **[show-me](./show-me/SKILL.md)** — Explain the current topic visually with the smallest view that makes the point: pseudocode, call trees, component trees, file trees, Mermaid diagrams, diffs, or a focused HTML artifact.
- **[teach](./teach/SKILL.md)** — Teach a new skill or concept over multiple sessions using a stateful teaching workspace grounded in a mission, trusted resources, learning records, and a glossary.
- **[wait-what](./wait-what/SKILL.md)** — Fire this the moment a message doesn't land. The agent re-pitches it with the context you're missing, in plain English, using your `CONTEXT.md` vocabulary.
- **[writing-for-agents](./writing-for-agents/SKILL.md)** — Writing documents for agents: skills, AGENTS.md/CLAUDE.md, and any doc an agent reaches by a pointer.
