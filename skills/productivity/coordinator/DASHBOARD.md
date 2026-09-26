# Fleet dashboard

The dashboard is the user's window into the fleet and the coordinator's ledger, from one file: `state.json`. The state CLI is the only way you touch it: one command per event, which validates the change and renders the page. The page itself is a fixed template, never rewritten by hand.

## Where things live

- **State**: `<scratchpad>/coordinator/state.json`, created and changed only through `scripts/state.py` (below). [assets/example-state.json](assets/example-state.json) shows a filled-in state for reference.
- **Render**: done by every `state.py` command. `scripts/render_dashboard.py` is what it calls, and the only reason to run it directly is `--fragment` for the Artifact tool.
- **Publish**: serve the directory over the tailnet, once per session:
  `python3 <skill-dir>/scripts/serve_dashboard.py <scratchpad>/coordinator`. The script starts a local file server on a free port and exposes it through `tailscale serve`, which terminates TLS with a certificate Tailscale issues for this machine, and prints `https://<magicdns-name>:<port>/`, reachable from any device on the tailnet and from nowhere else. Several coordinators on one machine each get their own port. Give the user the URL once. Every later render is picked up by the page on its own: it polls `state.json` beside it every few seconds and re-renders in place, filters intact. Stop the server with `--stop` when the session ends; that also removes the `tailscale serve` entry. When `tailscale serve` is refused (HTTPS not enabled for the tailnet, or the user is not the Tailscale operator) the script falls back to plain http on the Tailscale IP and says so.
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
  important  true when the user should see it now (optional; absent means routine)
```

## The state CLI

`python3 <skill-dir>/scripts/state.py <scratchpad>/coordinator <command>`. Create and update share a verb: an unknown id with its required fields creates the row, a known id changes only the fields given. Timestamps are stamped for you, ids you reference are checked, and every command renders.

| Event | Command |
| :-- | :-- |
| Intake done | `init --project P --goal G`, then `milestone m1 --title T` and `step s1 --milestone m1 --title T` per step, then `event --kind decision "why the split"` for anything non-obvious |
| Worker spawned | `agent a1 --task T --skill tdd --milestone m1 --lane src/x.ts test/x.test.ts --step s1 --brief "done when ..."` (model defaults to opus; logs the spawn, marks the step current) |
| Notification arrives | `agent a1 --status done --tokens N --duration-ms N --report "..." --step s1 --log "what it verified"` (the step follows the status; the log becomes a `reported` event) |
| Worker blocked | `roadblock r1 --title T --detail D --severity serious --needs user --agent a1` (marks the worker blocked, logs it) |
| Roadblock cleared | `roadblock r1 --resolved` (worker back to running, logs it) |
| Model proposal or other decision | `event --kind decision "proposed haiku for the rename sweep; user approved"` |
| Milestone checks pass | `step s2 --status done` for any step not already done, `event --kind integrated "checks green"`, `set --now "..."` |
| The user must see something now | `--important` on `event`, `agent --log`, or `roadblock`; `--needs user` and a failed worker imply it |
| Session ends | `set --status done --now "..."` |

`show` prints the ledger as text when you need to check it without opening the page. Add `--no-render` to any command when several follow in a row, and let the last one render.

## What the page shows

- Header: project, goal, status pill, the `now` line, started and updated times.
- Summary tiles: workers by status, total tokens, elapsed time, open roadblocks.
- Roadmap with the current step marked; steps link to their worker.
- Roadblocks, open first, with who is needed.
- Fleet table with filters (status, milestone, skill, model, free text) and expandable rows for brief and report.
- Token chart: one bar per worker, coloured by spawn order, hover for the figures, with the table as the accessible alternative.
- Activity log, newest first, filtered together with the table.
- Notifications: every event is one. A bell in the top right carries the unread count and opens the list, with mark-read, clear, and the sound and toast preferences. New events show as toasts; important ones stay until dismissed, chime, and flag the tab title. Browsers allow sound only after the viewer has clicked the page once, so a viewer who never interacts still gets the toast and the badge.

Filters and the expanded rows survive each re-render (the page keeps them in the viewer's browser), so the user's view is not reset by your updates.
