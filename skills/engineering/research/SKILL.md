---
name: research
description: "Investigate a question against primary sources and save the findings as Markdown in the repo. Use to research a topic, gather docs or API facts, or delegate reading to a background agent."
---

Spin up a **background agent** to do the research, so you keep working while it reads. It is a Researcher ([MODELS.md](../../productivity/coordinator/MODELS.md)), whoever spawns it, a worker researching for its own task included. It moves up (the Researcher row's last column) only when the question itself needs judgement: sources that contradict each other, a design trade-off to weigh, a conclusion someone will build on without checking.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
