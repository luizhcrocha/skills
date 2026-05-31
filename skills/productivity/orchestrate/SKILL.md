---
name: orchestrate
description: Take a set of pending tasks, or user given tasks, and run them in parallel across agents — picking subagents, a dynamic workflow, or an agent team — partitioned so the workers never touch the same files. Use when the user wants to parallelize work, fan out tasks, "orchestrate" a batch of changes, run a workflow, or coordinate multiple agents on one codebase.
---

# Orchestrator

Drive a batch of work across multiple agents without conflicts. You decide what to parallelize, pick the right primitive, partition the work so no two workers edit the same files, and brief every worker on the standards they must follow.

## Process

### 1. Gather the work

Find the tasks to resolve. In order of preference:

- The active task list (`TaskList`) — anything `pending`.
- A plan, PRD, issue list, or TODOs the user points at.
- Open threads in the current conversation.

If the set is unclear, list what you found and confirm scope before spawning anything.

### 2. Partition to avoid conflicts

Two workers editing the same file overwrite each other. Before fanning out:

- Group tasks by the **files/modules they touch**. Each worker owns a disjoint set.
- Tasks that share files go to the **same** worker, run **sequentially**.
- Encode true ordering as dependencies (a task can't start until its prerequisite finishes).
- Shared scaffolding (types, schemas, configs many tasks import) — do it **first, yourself**, before fanning out the dependents.

If the work can't be cleanly partitioned, say so and fall back to sequential.

### 3. Pick the primitive

| Use | When |
| :-- | :-- |
| **Subagents** (Agent tool) | A few independent tasks; you only need the result back. Cheapest. Spawn several in one turn for parallelism. |
| **Dynamic workflow** (`workflow` keyword) | Can spawn dozens–hundreds of agents, a repeatable pattern (audit, large migration, cross-checked research), or you want the orchestration saved as a rerunnable script. Runs in background; results stay out of your context. Up to 16 concurrent / 1,000 total agents. |
| **Agent team** (experimental, opt-in) | Workers must talk to each other — adversarial review, competing-hypothesis debugging, cross-layer changes. Needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Higher token cost. |

Default to subagents. Reach for a workflow only at scale, on the suggested use cases or when the user asks for one; reach for a team only when workers genuinely need to coordinate. Tell the user which you chose and why.

### 4. User Validation

Before you start spawning agents, show the user the list of tasks you plan to parallelize and how you plan to partition them. 

Ask them the maximum number of parallel agents to run and to confirm that they want to proceed with that plan.

### 5. Brief every worker

Each worker gets a fresh context window — it knows nothing you know. In every spawn prompt include:

- The task and its **exact file ownership** ("you may only edit X, Y").
- The **standards block** below, verbatim.
- How to report back (what "done" looks like).
- If more optimal, considering the tasks:
  - To avoid making the agents repeat skill calls, pre-run the skills yourself and give the workers the results. If you alredy have ran the skills, and there's no need to re-run them, just pass the results.
  - If the work is similar across agents, write a template prompt and have them fill in the blanks instead of writing separate prompts.

### 6. Integrate

Collect results, resolve anything left at the seams, run the project's checks (types/tests/lint), and report what each worker did. Keep workers on their lanes — if one strays into another's files, stop it.

## Standards block (paste into every worker prompt)

> Follow these standards:
> - In case you are not passing the skills contents, tell the agents to apply
    - The **improve-codebase-architecture** skill's thinking — deep modules, real seams, the deletion test, consistent domain/architecture language. **Do not write an HTML report**; just apply the principles to the code you write.
    - For any HTML/CSS/clientside-JS work, the **modern-web-guidance** skill *first* and follow the guides it returns.
    - For UI/frontend work, the **frontend-design** skill if it is available.
> - Stay strictly within your assigned files. If you need to touch a file outside your lane, stop and report it instead of editing.

## Notes

- Subagents inherit your tool allowlist; pre-approve the commands workers need to avoid mid-run permission prompts.
- Workflows: trigger with the word `workflow` in the prompt (or `/effort ultracode` to let Claude decide); watch with `/workflows`; save a good run with `s`.
- Cost scales with agent count — parallel runs trade tokens for wall-clock time. Use a smaller model for stages that don't need the strongest one.
