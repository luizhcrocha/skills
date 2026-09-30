# Investigation

**You own the answer. Plan, route, write.**

Read-only. The deliverable is a cited explanation or a recommendation, not a code change.

1. Map the subsystem the question touches: `CONTEXT.md`, `docs/adr/`, the code paths involved. More than a handful of files → `tstack:how` maps it (Sonnet explorers, file:line pointers).
2. For a motivation question ("why was it built this way?"), read the history: `tstack:recall` for memo notes and past sessions, `jj log -r '::@' -- <path>` and `jj file annotate <path>` for the changes and their messages (pending merge: why).
3. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
4. Write the answer in the shape the question takes: Overview, Key concepts, How it works, Where things live (file:line), Gotchas. A decision between alternatives gets a recommendation with a trade-offs table. A diagram earns its place only when it shows the mechanism (`tstack:show-me`).
5. Check the reply against [Writing the reply](../SKILL.md#writing-the-reply).

No Land. When the investigation turns into a code change, say so and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?", your real judgement with reasons; push back when the premise is wrong.
