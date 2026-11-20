# Investigation

**You own the answer. Plan, route, write.**

Read-only. The deliverable is a cited explanation or a recommendation, not a code change.

1. Map the subsystem the question touches: `CONTEXT.md`, memo (`memo recall`), the code paths involved. More than a handful of files → `tstack:how` maps it (Researcher explorers, file:line pointers).
2. For a motivation question ("why was it built this way?", a threshold, a guard, a regression's origin), `tstack:why` answers from the record (the jj history and PRs, then docs, memo, the tracker and chat when the trail is thin), citing the authors and marking inferences. A single fact from the record ("which change added this?") is a lookup instead: `tstack:recall`, `jj log -r '::@' -- <path>`, `jj file annotate <path>`.
3. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
4. Write the answer in the shape the question takes: Overview, Key concepts, How it works, Where things live (file:line), Gotchas. A decision between alternatives gets a recommendation with a trade-offs table. A diagram earns its place only when it shows the mechanism.
5. Check the reply against [Writing the reply](../SKILL.md#writing-the-reply).

No Land. When the investigation turns into a code change, say so and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?", your real judgement with reasons; push back when the premise is wrong.
