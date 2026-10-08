# Agent roles fix each spawn's model and effort

Status: accepted, 2026-10-08 (Luiz). Tables: [coordinator/MODELS.md](../../skills/productivity/coordinator/MODELS.md). Evidence page: [Agent Lanes](https://claude.ai/artifact/9pC3GzNim2rSou8jNEffBK).

## Context

tstack's skills start about 60 kinds of agent: readers, researchers, implementers, reviewers, judges, an advisor. Before this decision each skill named a model in its own words, the rule was restated in eight places that had drifted apart, eight spawns named no model at all, and no spawn set a thinking effort. Claude 5.x models take an effort level per request (low, medium, high, xhigh, max), and Claude Code's Agent tool and agent definitions take it per agent.

Measured on 2026-10-08: a spawn without an effort ran at Sonnet medium, Opus medium and Fable high. Sourced (Artificial Analysis index by effort; Anthropic's Haiku 5.5 launch page; the manager's model research in custom-mcp-servers `docs/research/2026-10-07-thinking-effort.md`):

- Opus gains most from low to medium (+9) and about +2 per step from high on, for twice the tokens.
- Sonnet climbs steadily to xhigh and scored lower at max than at xhigh on FrontierCode, because it over-delegated.
- Fable's curve is flat: 47 at low, 53 at xhigh and at max.
- Haiku 5.5 is built for subagent work, summaries and lookups, at a twentieth of Sonnet's output price. It trails Sonnet by 31 points on Terminal-Bench 4.0.

## Decision

Every spawn plays one of ten roles: Watcher, Reader, Researcher, Composer, Implementer, Reviewer, Verifier, Decider, Escalation and Advisor. The role fixes the model, the effort and the fallback.

- **One table holds the pairs.** MODELS.md is the only place the pairs are written, apart from `agents/*.md` frontmatter and the fleet's role tables (`fleet/src/ledger/roles.ts`, `coordinator/scripts/state.py`). Skills name the role and link to it. `scripts/tests/test_models.py` fails when a skill or an agent names a pair the table lacks.
- **The role follows the task's shape, not the budget.** Does it write code? Does its call decide what follows? Does it only read and reduce? Does anyone wait on it?
- **Effort is fixed for an agent's life,** because changing it drops the message cache.
- **The limits:**
  - never max;
  - never Fable for fan-out;
  - fall back by availability, said in the reply;
  - a test run takes the target session's pair.
- **Haiku 5.5 joins the approved models** for two roles. A one-run side-by-side on a real transcript and a real service log found Haiku high as complete as Sonnet medium and more exact.
  - Readers run on Haiku high, spawned as `tstack:reader` with read-only tools, because Haiku wrote a file against a "write nothing" brief.
  - Watchers run on Haiku low, or as a background shell loop when the watch is a command.
  - Reading that judges what it finds stays on the Researcher's Sonnet.
- **Escalation is Fable high, once, behind an evidence gate** (diagnosing-bugs Phase 3). It is not xhigh, because the escalated agent runs 20 to 40 turns. It is not Opus xhigh first, because that shares the failed agent's blind spot and is the slowest per turn. Fable's value here is a second reasoner, not a higher index: Opus high scores 54 against Fable high's 51.
- **Agents that condense follow the reducer contract** in MODELS.md: a cap, a keep order, exact ids, never overstating progress. There is no separate Compressor role.

## Considered and rejected

- **A pair written in each spawn sentence:** it recreates the drift the table removes.
- **Effort chosen per call by budget:** it changes effort mid-agent and drops the cache.
- **Haiku for researchers, implementers or reviewers:** it is weak on long tool and terminal loops.
- **A Compressor role on Haiku xhigh (UniiChat's choice):** +3 index points for an 87 s first token, on lines of 280 characters.

## Evolving it

- **A new model or price** changes MODELS.md's table, the two fleet role tables and this record's Context. `test_models.py` and the fleet's oracle traces catch a pair that is missing from one of them.
- **Measuring instead of inferring:** every pair rests on a general index, except the Reader check. A swarm running each role's real tasks at two efforts replaces an inference with a measurement. Record the result here and in the table's "why" line.
- **The escalation choice:** for the next ten or so escalations, run Opus xhigh beside Fable high with the same brief. If Opus matches, Escalation moves to Opus xhigh. If most answers are "run this probe", the gate matters more than the model.
- **The Reader check** was one run per task. A miss by Haiku on a later reader task moves that task to the Researcher role, and the table records why.
