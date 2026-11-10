# Agent roles fix each spawn's model and effort

Status: accepted, 2026-10-08 (Luiz). Tables: [models.md](../models.md). Evidence page: [Agent Lanes](https://claude.ai/artifact/9pC3GzNim2rSou8jNEffBK).

The fleet half of this decision (the fleet's role table and its enforcement) moved to the fleet repo; the model tables stay here.

## Context

tstack's skills start about 60 kinds of agent: readers, researchers, implementers, reviewers, judges, an advisor. Before this decision each skill named a model in its own words, the rule was restated in eight places that had drifted apart, eight spawns named no model at all, and no spawn set a thinking effort. Claude 5.x models take an effort level per request (low, medium, high, xhigh, max), and Claude Code's Agent tool and agent definitions take it per agent.

Measured on 2026-10-08: a spawn without an effort ran at Sonnet medium, Opus medium and Fable high. Sourced (Artificial Analysis index by effort; Anthropic's Haiku 5.5 launch page; the manager's model research in custom-mcp-servers `docs/research/2026-10-07-thinking-effort.md`). The four figures below are the 2026-10-28 corrections of the first reading, which came from an older index (Opus +9 then about +2 per step, Fable 47 at low and 53 at xhigh, a 31-point Haiku gap, Sonnet worse at max); see the 10-28 bullet under Evolving it:

- Opus gains most from low to medium (+13.6 index points) and 5.3 from high to xhigh (51.7 to 57.0), at 1.75 to 2.1 times the cost.
- Sonnet climbs steadily to xhigh and scores higher at max than at xhigh on FrontierCode (41.0 against 34.8) and on the index.
- Fable's curve is nearly flat: 38.5 at low, 47.0 at high, 49.7 at xhigh, 49.0 at max.
- Haiku 5.5 is built for subagent work, summaries and lookups, at a twentieth of Sonnet's output price. It trails Sonnet on Terminal-Bench 4.0 by 14.6 points at medium and 22.2 at high.

## Decision

Every spawn plays one of ten roles: Watcher, Reader, Researcher, Composer, Implementer, Reviewer, Verifier, Decider, Escalation and Advisor. The role fixes the model, the effort and the fallback.

- **One table holds the pairs.** models.md is the only place the pairs are written, apart from `agents/*.md` frontmatter and the fleet's role tables (`fleet/src/ledger/roles.ts`, `coordinator/scripts/state.py`). Skills name the role and link to it. `scripts/tests/test_models.py` fails when a skill or an agent names a pair the table lacks.
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
- **Escalation is Fable high, once, behind an evidence gate** (diagnosing-bugs Phase 3). It is not xhigh, because the escalated agent runs 20 to 40 turns. It is not Opus xhigh first, because that shares the failed agent's blind spot and is the slowest per turn. Fable's value here is a second reasoner, not a higher index: on the 10-28 index Opus high scores 51.7 against Fable high's 47.0. Effort escalation (below) differs: it reruns the same task with the review's finding in the brief, so the blind-spot argument does not apply, where the Escalation role gives a second opinion on a judgement.
- **Agents that condense follow the reducer contract** in models.md: a cap, a keep order, exact ids, never overstating progress. There is no separate Compressor role.

## Considered and rejected

- **A pair written in each spawn sentence:** it recreates the drift the table removes.
- **Effort chosen per call by budget:** it changes effort mid-agent and drops the cache.
- **Haiku for researchers, implementers or reviewers:** it is weak on long tool and terminal loops. The one exception is the 10-28 trial, which runs mechanical edits on Haiku xhigh.
- **A Compressor role on Haiku xhigh (UniiChat's choice):** +3 index points for an 87 s first token, on lines of 280 characters.

## Evolving it

- **A new model or price** changes models.md's table, the two fleet role tables and this record's Context. `test_models.py` and the fleet's oracle traces catch a pair that is missing from one of them.
- **Measuring instead of inferring:** every pair rests on a general index, except the Reader check. A swarm running each role's real tasks at two efforts replaces an inference with a measurement. Record the result here and in the table's "why" line.
- **The escalation choice** (retired 2026-11-10, see the 11-10 bullet): for the next ten or so escalations, run Opus xhigh beside Fable high with the same brief. If Opus matches, Escalation moves to Opus xhigh. If most answers are "run this probe", the gate matters more than the model.
- **The Reader check** was one run per task. A miss by Haiku on a later reader task moves that task to the Researcher role, and the table records why.
- **10-28, the figures corrected, effort escalation and a trial.** Luiz chose option a of decision "frontiercode". Evidence read 2026-10-28: Cognition's FrontierCode 2.0 (leaderboard of 10-27) and the Artificial Analysis Intelligence Index v5.
  - Figures: both put Opus 5.5 xhigh over high (FrontierCode 34.5 to 43.4, index 51.7 to 57.0) at 1.75 to 2.1 times the cost, and AA puts the first token at 131 s against 35 s. models.md's "xhigh buys about 2 points" was wrong, and its low, medium and Fable index figures probably came from an older index.
  - Fallback: Sonnet xhigh (34.8 on FrontierCode, 49.6 on the index) matches Opus high, so it replaces Sonnet high as the Implementer and Reviewer fallback. A Quick review stays on Sonnet high, the cheap level. Sonnet scores higher at max than at xhigh on both sources, so "never max" rests on cost and latency alone.
  - Fable: Opus 5.5 beats Fable 5.1 at the same effort from medium up on both sources, but neither measures judgement, so Fable keeps the decisive roles (Luiz's rule) and the Opus xhigh trial above stays open.
  - Effort escalation, Implementer lanes only: a lane reruns at Opus xhigh as a fresh worker when review returns FIX with an Important finding a second time, the same check fails twice, the worker reports `blocked` on a technical problem, or it hands off at about 150k tokens short of its done criterion. A rerun that trips a trigger again goes to the advisor, and the rerun runs on Sonnet xhigh when Opus is unavailable.
  - Trial: the next 20 non-mechanical Implementer lanes rotate Opus medium, high, xhigh by order; mechanical edits run on Haiku xhigh outside the 20. The record is one `note` event per lane in the fleet's ledger, filed under the arm of the lane's first attempt, with `escalated` and the rerun's cost in the lane's total. Cost comes from the transcripts' per-call usage (input, cache writes, cache reads, output) at list prices, because a row's `tokens` is only the last answer's context. Until the fleet reads that usage, the record says `cost unknown`. Mechanical edits return to Opus high after the 20 lanes until the result is decided. The result decides the next change.
  - Code: the role table's twins approve xhigh on Opus, Sonnet and Haiku for this.
- **11-10, Fable 5.2 and new prices.** Since 2026-11-10 the `fable` alias serves Fable 5.2, at $8 and $40 per million tokens (2 times Opus, not 2.5), with cache reads at $0.20; Sonnet's cache reads are $0.10. Anthropic reports Fable 5.2 high at 45.3% on FrontierCode against Opus 5.5 max at 45.5%, for about half the cost per task (claude.dev, "Which Claude model should you build with?", 2026-11-09). The Context's Fable figures and the escalation trial's premise (Opus high above Fable high) are 5.1's. No pair changes until FrontierCode's and the index's own 5.2 rows are read; models.md carries the prices.
- **11-10, Luiz's decisions on the advisor's ruling.** The Artificial Analysis index read that day puts Fable 5.2 high at 62 against Opus 5.5 xhigh at 57 and max at 59; FrontierCode's 5.2 rows are unread.
  - The Opus xhigh against Fable high escalation trial is retired: its premise was Opus scoring above Fable.
  - The Decider falls back to Opus xhigh. Escalation and the Advisor keep Opus high, because they run many turns.
  - After the 20-lane trial, its report decides whether an Implementer rerun moves to Fable high, one rerun at a time.
  - The served model is recorded from the transcript, because a safety reroute to Opus 4.8 shows there.
  - The dollar figures rank options: the skills run in Claude Code on a subscription, where the cost is the plan's usage limits. API work in custom-mcp-servers is reviewed against the prices on its own.
- **11-10, context by role and coordinator effort.** Luiz, after an advisor's ruling priced from coordinator session 8c9c0fa8's transcripts (Opus $420 at list price: the coordinator $170, its 134 workers $250). Workers keep the 150k stop: 250k only breaks even, and the 10-lane context trial is dropped with 0 lanes run. Readers stop at 100k, where Haiku's price steps up. Coordinators and the manager move from Opus low to Opus medium and compact at 300k, both set by `fleet team`'s launch flags so his own sessions keep 500k; the fleet host restarts a coordinator from its ledger past 200k at a quiet point, since a compaction leaves 128-149k and a fresh session 65k. Plan limits on Ultra are weekly only, and how they weigh cache reads is unpublished.
