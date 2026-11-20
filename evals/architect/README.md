# Architect's design eval

Measures a change to the design skills (`architect`, `principles`) before it lands: the same tasks are sketched with the skills as they are (base) and as changed (cand), and judges who don't know which is which pick the better design. Built and first run on 2026-11-18 (two runner-prompt rules kept, one dropped); the trail is in that session's scratchpad.

## A round

1. Change the skills in your checkout (the cand arm), or in a copy.
2. `evals/architect/eval-round stage <round-dir> [--cand DIR] [--task NAME]...`. The round directory goes in the scratchpad. It prints one sketch brief per arm and task.
3. One Opus agent per sketch brief, the brief as its whole prompt, all in one message.
4. `eval-round pair <round-dir>` once every sketch is written. It copies each task's two sketches onto random sides, then swapped, and prints one judge brief per task and order.
5. One Fable agent per judge brief, the brief as its whole prompt.
6. `eval-round score <round-dir>`. Exit 0 keeps the change: cand wins more than half the tasks (summed over both orders) and its total is higher. Exit 1 drops it.

A round costs two Opus sketches and two Fable judgements per task. Pick the tasks the change is meant to move, plus one it is not, so a gain on one shape cannot hide a loss on another.

## The tasks

| Task | What it tests |
|---|---|
| `webhooks` | Durable, stateful work: retries, idempotency under a caller crash, waiting on an outcome |
| `permissions` | Data shape and the hot-path call site: inherited roles, batch filtering, a dated audit |
| `config` | A small module, where machinery the requirements don't need shows |
| `reports` | Held out of the rules' wording: recurrences in time zones, missed runs, several instances |

Add a task when a real design run shows a flaw no task exercises. Keep each one a paragraph, with stated requirements and no hints at the design.

## Reading the result

- The judge's rubric names no rule from the skills, so a rule must show up as a better design, not as a box ticked.
- One judge reading the same pair can differ by about two points from another, so a single task's margin under three is noise. The swapped order removes the judge's side preference.
- Read the judgements, not only the score: a flaw named in the losing design is the next rule to try, and a flaw in the winner is one the skills still miss.
