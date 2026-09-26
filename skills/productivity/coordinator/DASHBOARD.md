# Fleet dashboard

The dashboard is the user's window into the fleet and the coordinator's ledger, from one file: `state.json`. Edit the state, render. The page itself is a fixed template, so an update is a JSON edit plus one command, never a rewrite of HTML.

## Where things live

- **State**: `<scratchpad>/coordinator/state.json`. Start it by copying [assets/example-state.json](assets/example-state.json) and replacing every field; the example is the schema.
- **Render**: `python3 <skill-dir>/scripts/render_dashboard.py <scratchpad>/coordinator/state.json <scratchpad>/coordinator/index.html`. The script stamps `updated` with the current time and fails loudly on a malformed state.
- **Publish**: serve the directory over the tailnet, once per session:
  `python3 <skill-dir>/scripts/serve_dashboard.py <scratchpad>/coordinator`. The script binds a free port on this machine's Tailscale address and prints `http://<magicdns-name>:<port>/`, reachable from any device on the tailnet and from nowhere else. Several coordinators on one machine each get their own port. Give the user the URL once. Every later render is picked up by the page on its own: it polls `state.json` beside it every few seconds and re-renders in place, filters intact. Stop the server with `--stop` when the session ends.
  If the user asks for a claude.ai artifact instead (no tailnet on their device), render with `--fragment` to `dashboard.html` and publish it with the Artifact tool (`icon: "chart"`, a one-sentence `description`), republishing the same path after every state change; open viewers receive each republish without reloading.

## State schema

Every list is ordered as the user should read it. Timestamps are ISO 8601 with a timezone.

```
project      string   repo or project name
goal         string   the user's ask in one sentence
status       running | paused | blocked | done
now          string   one line: what is happening right now
started      ISO      when coordination began
updated      ISO      set by the render script

roadmap[]    ordered milestones
  id, title
  steps[]    id, title, status (done | current | pending | blocked), agent (agent id or null)

agents[]     one row per worker, in spawn order (its position picks its chart colour, so append, never reorder)
  id         short stable id, also used in steps/roadblocks/events
  name       what the user calls it ("auth-impl")
  task       one sentence
  skill      implement | diagnosing-bugs | prototype | research | tdd | none
  model      opus | sonnet | haiku | fable
  status     queued | running | blocked | done | failed | stopped
  lane[]     files or globs the worker may edit
  milestone  milestone id
  tokens     integer, from the task notification (0 until the first one)
  duration_ms integer, same source
  started, updated   ISO
  brief      the completion criterion given to the worker
  report     the latest report, verbatim or condensed

roadblocks[]
  id, title, detail
  agent      agent id or null
  severity   warning | serious | critical
  needs      user | coordinator | worker
  since      ISO
  resolved   boolean

events[]     activity log, oldest first
  at         ISO
  agent      agent id or null (coordinator events)
  kind       spawned | reported | blocked | resolved | decision | note | integrated
  text       one or two sentences
```

## What to update, when

| Event | State edit |
| :-- | :-- |
| Intake done | `roadmap`, `goal`, `now`, an event of kind `decision` per non-obvious split |
| Worker spawned | append to `agents` (status `running`), set its step to `current`, event `spawned` |
| Notification arrives | `tokens`, `duration_ms`, `updated`, `report`, `status`; event `reported` |
| Worker blocked | agent status `blocked`, a roadblock with `needs`, step status `blocked`, event `blocked` |
| Roadblock cleared | `resolved: true`, statuses back to `running`/`current`, event `resolved` |
| Model proposal | event `decision` with the proposal and the user's answer |
| Milestone checks pass | its steps `done`, next step `current`, event `integrated`, `now` |

Render after each row. A stale dashboard is worse than none: the user acts on it.

## What the page shows

- Header: project, goal, status pill, the `now` line, started and updated times.
- Summary tiles: workers by status, total tokens, elapsed time, open roadblocks.
- Roadmap with the current step marked; steps link to their worker.
- Roadblocks, open first, with who is needed.
- Fleet table with filters (status, milestone, skill, model, free text) and expandable rows for brief and report.
- Token chart: one bar per worker, coloured by spawn order, hover for the figures, with the table as the accessible alternative.
- Activity log, newest first, filtered together with the table.

Filters and the expanded rows survive each re-render (the page keeps them in the viewer's browser), so the user's view is not reset by your updates.
