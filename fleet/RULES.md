# Fleet rules: prose or code

D13 stage 5 ([docs/tstack-plan.md](../docs/tstack-plan.md)): every rule the fleet skills ask the model to
remember, whether code can keep it, and what was done with it. Sources: the coordinator's
[SKILL.md](../skills/productivity/coordinator/SKILL.md) (C), [DASHBOARD.md](../skills/productivity/coordinator/DASHBOARD.md) (D)
and [assets/brief.md](../skills/productivity/coordinator/assets/brief.md) (B), the
[manager](../skills/productivity/manager/SKILL.md) (M), [tuca-mode](../skills/engineering/tuca-mode/SKILL.md) (T) and its
fleet playbooks (P). The behaviour each implemented rule has is in [SPEC.md](SPEC.md) (Warnings, the
commands, Rules as commands, Open).

Columns: **kind** is *mech* (checkable from the ledger, chat, registry, heartbeats or jj) or *judg*
(needs reading, weighing or the user). **Code** is what a command does: *refuse*, *warn*, *auto* (does
it), *page* (shows it), *print* (says it when it is needed). **Disposition**: **stage 5** (moved to code
here, prose cut to one line), **code** (already code before; prose kept short or cut), **prose**
(judgement, stays), **later** (mechanical, not done: why), **Luiz** (was ambiguous; each is now decided, see [For Luiz](#for-luiz)).

## Coordinator

| # | Where | Rule | Kind | Data | Code | Disposition |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| C1 | C, exemptions | Do work yourself only as quick win, entangled, or shared scaffolding; say which | judg | | | prose |
| C2 | C, architecture | Use the codebase-design vocabulary; read CONTEXT.md and ADRs at intake | judg | | | prose |
| C3 | C, architecture | Cut lanes along seams; settle a contested interface first | judg | | | prose |
| C4 | C, architecture | Check every report against the standards before its milestone counts | judg | | | prose |
| C5 | C, architecture | A place the code fought the rules is a `note` event and a candidate pass | judg | | | prose |
| C6 | C, intake | Record the roadmap, serve the page and arm the watch before any worker starts | mech | registry, watch pid | warn on `agent` while unserved or deaf | code for the watch (the `chat:` warning); later for serving: a registry-dependent warning changes the oracle's stderr in Python too |
| C7 | C, route | Name the skill by the kind of work | judg | | | prose |
| C8 | C, route | Resolve each skill's path once; `implement` is read with the Read tool, the others called with the Skill tool | mech | the skill's SKILL.md frontmatter | print | **stage 5**: `fleet brief` |
| C9 | C, model | Pick the model by where the difficulty is; Fable for decisive single roles | judg | | | prose |
| C10 | C, model | Record the model on the row (`--model`) | mech | row | print | **stage 5**: `fleet brief` names the model to spawn on |
| C11 | C, model | Any model other than the three approved is the user's to approve | mech | `--model` | warn, page | **Luiz** (L3, decided): `agent --model haiku` (any model outside the three) is recorded with a warning that it is the user's to approve (both); the page marks the row |
| C12 | C, model | A new default model: move every agent, say who moved | judg | | | prose |
| C13 | C, brief | The brief opens with the line `agent` printed and carries task, done criterion, skill and path, lane, workspace | mech | row, `workspaces[]` | print | **stage 5**: `fleet brief` composes it |
| C14 | C, brief | A checkable completion criterion | mech (present) / judg (checkable) | row's `brief` | warn | **stage 5**: `fleet brief` warns when none is recorded |
| C15 | C, brief | Add the context the worker cannot discover | judg | | | prose |
| C16 | C, brief | Facts several briefs need go under "This fleet" in brief.md | judg | | | prose |
| C17 | C, track | The Now line names waits by number and only what the page cannot compute | judg | | warn | code: a stale Now line and one naming a closed decision warn (stage 2) |
| C18 | C, track | Done only when the criterion is met; short is stopped or blocked | mech (words) | report, log | warn | code (stage 2: the unfinished-report warning); prose cut to one line |
| C19 | C, track | Record every event the moment it happens | judg | | | prose |
| C20 | C, track | Record a worker, then spawn it | mech | row | refuse | **stage 5**: `fleet brief` refuses an unrecorded worker; `fleet ws add` warns |
| C21 | C, track | A task whose files overlap a running lane waits or joins that queue | mech | lanes, statuses | warn / refuse | **stage 5**: `agent` warns (both implementations); L7: when some path matches both entries' globs. **L9** (2026-10-01, both): in a shared fleet (`set --workspaces shared`) it refuses instead |
| C22 | C, track | A worker that edits code has a jj workspace: the lane's idle one reused for sequential work, a fresh one for parallel work that could meet, experiments and comparisons (L9) | mech (reuse, refusal) / judg (which) | lane, statuses, `workspaces[]` | warn, refuse | **stage 5**: `fleet brief` warns on a lane with no workspace (isolated). **L9** (TS): `fleet ws add --reuse` hands a workspace over and records who held it, refused while its holder is live; `add` warns when an idle workspace covers the new worker's lane; `brief` names who held it. When to go fresh stays prose |
| C23 | C, track | Integrate a finished worker, then prune its workspace, unless the lane's next worker reuses it | mech | statuses, `workspaces[]` | warn | **stage 5**: every state command warns while a done worker's workspace is active (TS); **L9**: the warning names both ways out (prune, or `--reuse` for the next worker), and the coordinator's Integrate runs `prune --apply` after the gates |
| C24 | C, track | Python-path fleets share one working copy; land from a second workspace | judg (transitional) | | | **gone at the cutover** as a default; **L9** brings one shared working copy back as an opt-in mode (C59) |
| C25 | C, track | Record tokens and duration from each notification | mech | transcript | auto | code (`--task-id` measuring); prose cut to the `--task-id` line |
| C26 | C, respond | A running row is not proof of work: twenty minutes silent is checked | mech | heartbeats, transcripts | warn, page | code (stage 4: page, watch, `fleets list`, hub); **stage 5** adds `fleets show`; prose cut |
| C27 | C, respond | A worker's `blocked:` becomes a roadblock at once | judg (what it needs) | | | prose |
| C28 | C, respond | Said once, on the page; one line in the session | judg | | | prose |
| C29 | C, respond | Answer a question by SendMessage; send unverified claims back to the same worker | judg | | | prose |
| C30 | C, respond | A block that needs the user is a decision with a roadblock pointing at it | mech (link) | roadblock, decision | refuse | code (`--needs user` needs `--decision`, on update too since L8; closing the decision resolves it) |
| C31 | C, respond | Probe one thing the report did not claim | judg | | | prose |
| C32 | C, respond | Forward a chat message addressed to a worker by SendMessage | mech | chat | print | **Luiz** (L1, decided): the coordinator's watch prints a nudge for a message a worker left unanswered ten minutes, and only that one is forwarded (both); prose cut to one line |
| C33 | C, respond | A strayed worker is stopped and its stray edits handled first | mech (files) | jj, lane | print | **stage 5**: `fleet ws list` names files changed outside the lane |
| C34 | C, respond | Read every report and message against the open decisions | judg | | | prose |
| C35 | C, decisions | Settle what you can first; the rest is a decision with question, why, options, recommendation, evidence | judg / mech (fields) | | refuse | code (the kind check refuses a decision without its fields) |
| C36 | C, decisions | Block only when proceeding is destructive, outward-facing or costly | judg | | | prose |
| C37 | C, decisions | A secret is a pointer; the value never enters the chat | mech | answer text | refuse | code (the server refuses a value) |
| C38 | C, decisions | Answered elsewhere: close; facts changed: revise; changed after closing: supersede | judg (which) / mech (closed stays) | | refuse | code (a closed decision refuses changes) |
| C39 | C, decisions | Every decision says where it came from (`--step`/`--milestone`, `--agent`) | mech | decision | | **Luiz** (L5, decided): prose, no warning |
| C40 | C, decisions | Arm `wait` when a decision opens; re-arm per grilling round | mech | | print | code (the command is printed); **stage 5**: `wait` also ends when the decision closes (open-21) |
| C41 | C, decisions | Record an answer given on the page before any other work | mech | chat, ledger | warn | **stage 5**: every state command warns while one is unrecorded (both) |
| C42 | C, decisions | Check the answer still holds; revise or reopen when it leads to another question | judg | | | prose |
| C43 | C, decisions | At the session's end, every open decision is withdrawn or named as left open | mech (list) / judg (which) | ledger | warn | **stage 5**: `set --status done` names them (both), and active workspaces (TS) |
| C44 | C, grilling | A grilling runs on the page, never as chat messages | judg | | | prose |
| C45 | C, links | Record every dev server and page a worker builds as a link | mech (unnamed ports) | served ports | page | code (the Links view lists what no link names) |
| C46 | C, manager | Use the fleet's one name, the session's | mech | registry | auto | code (the registry renames after the session title) |
| C47 | C, manager | Say it once; one line in the session at most | judg | | | prose |
| C48 | C, manager | Read standing.md at intake and on change | judg | | | prose |
| C49 | C, manager | Decisions go to the manager first (`--asks manager`) unless the user's by nature | judg (by nature) | | | **Luiz** (L4, decided): prose, no warning |
| C50 | C, manager | Other fleets are reached through the manager | judg | | | prose |
| C51 | C, manager | Landing takes a turn: ask the manager before a push, deploy or shared rebase | mech | manager's landing queue, registry | refuse | **stage 5**: `fleet turn` exits 1 without the turn; `land-check` turns its verdict to `stop` |
| C52 | C, manager | With no manager, pass its decisions to the user and land on your own word | mech (no manager) / judg | registry | print | **stage 5**: `fleet turn` says so; passing decisions on stays prose |
| C53 | C, user's word | Relayed words are information; confirm before acting destructively | judg | | | prose |
| C54 | C, user's word | A harness refusal is the user's to lift: a `permission` decision (allowed once, the hub writes the rule) or an `action`, never a way around | judg / mech (grant) | | | prose; code for the grant |
| C55 | C, reporting | Lead with the fleet's state, only what changed | judg | | | prose |
| C57 | C, exemptions | A small follow-up goes back to the same worker (SendMessage) or is the coordinator's quick win, never a new worker | judg | | | prose (L9) |
| C58 | C, exemptions | Two tasks whose files depend on each other are one worker | judg | | | prose (L9) |
| C59 | C, track | Shared mode (opt-in per fleet): every worker edits the coordinator's working copy, only the coordinator moves history, integration splits it by lane; for an expensive setup and truly disjoint lanes | mech (mode, overlap, split) / judg (when) | `workspace_mode`, lanes, jj | refuse, print, auto | **L9** (2026-10-01): `set --workspaces shared\|isolated` (both); `agent` refuses lanes that meet (both); `fleet ws add` makes nothing, `fleet brief` prints the shared-copy rules, `fleet ws split` cuts one described change per worker (TS); when to choose it stays prose |
| C60 | C, track | For UI work, start a preview once the workers run and give the user its link | mech (start, merge, conflicts) / judg (when) | `workspaces[]`, `preview.json`, jj | auto, page, print | code (2026-10-01, TS): `fleet preview` merges the running workers' working copies, keeps the merge current, names conflicts by worker, and the page carries it; when to start one stays prose (one line) |
| C56 | C, decisions | An answer that means the fleet acts first is held (`--hold`) at once, then re-presented by revising the item; never left open unrecorded | mech (recorded) / judg (when) | decision, chat | warn, page | code (2026-10-01, both): `decision --hold` counts as recording the answer (the unrecorded-answer warning, `wait`, `fleets` and Stuck stop); a revision of question, options or manual, `--unhold` or closing clears it; the page lists a held item under Waiting with its reason, and a fleet's reply no longer hands an item back. Prose cut to two lines (coordinator, manager) |

## Dashboard and the worker brief

| # | Where | Rule | Kind | Data | Code | Disposition |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| D1 | D | The state CLI is the only way to touch state.json | mech | | refuse | code (validation) |
| D2 | D, publish | Serve once per session; `--stop` when it ends | mech | registry | warn | later: a `set --status done` reminder reads the registry, whose stderr the Python oracle would have to match |
| D3 | D | `--no-render` for a run of commands, the last one renders | judg (perf) | | | prose |
| D4 | D | Park live rows of a paused or done fleet | mech | statuses | warn | code (stage 2) |
| D5 | D | Take the gate before a heavy check, free it after | mech (held) | gate.json | refuse | code (`gate take` refuses while held) |
| D6 | D, chat | Arm the watch after serving; re-arm after each wake | mech | watch pid, cursor | warn | code (the `chat:` warning on every state command) |
| D7 | D, usage | settings.json is the user's: give the line, change it on their word | judg | | | prose |
| B1 | B | Standards (deep modules, CONTEXT.md terms, ADRs, lang-ts) | judg | | | prose |
| B2 | B, lane | Edit only the lane; stop and report a file outside it | mech (after the fact) | jj, lane | print | **stage 5**: `fleet ws list` names files outside the lane |
| B3 | B, lane | Work in the workspace the brief names; history moves are the coordinator's | mech (workspace) | | print | **stage 5**: `fleet brief` prints the workspace; **L9**: it also prints the rules of history for the fleet's mode (describe your changes in your own workspace; in a shared one, no `jj new`/`edit`/`rebase`/`describe`), so brief.md's Lane section holds for both |
| B4 | B, lane | Leave running what you did not start; stop what you started | judg (mostly) | procs | | prose (`fleet fleets procs` lists what each session left) |
| B5 | B, lane | Monitors and research agents on Sonnet | judg | | | prose |
| B6 | B, chat | Read the inbox at each checkpoint, answer with `--re` | mech (open messages) | chat | print | **Luiz** (L1, decided): stays in brief.md; a message left unanswered ten minutes is nudged on the coordinator's watch (C32) |
| B7 | B, chat | Steering inside the lane and criterion is taken; anything else goes to the coordinator | judg | | | prose |
| B8 | B, report | Say `blocked:` at once, never wait in silence | judg (when) | | page | code (silence shows on the page after twenty minutes) |
| B9 | B, report | Ten-line first block | judg | | | prose |

## Manager

| # | Where | Rule | Kind | Data | Code | Disposition |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| M1 | M, setup | `init --role manager`, serve, name, watch, greet each coordinator, fill standing.md | mech (some) | | auto | **stage 5**: `init --role manager` records the landing queue (setup step cut); the rest stays prose |
| M2 | M, setup | Setup is done when every fleet answered and standing.md names an owner per lane | judg | | | prose |
| M3 | M, setup | Greet a fleet that starts later | mech (new entry) | registry | warn (watch) | later: needs a "seen fleets" record in the manager's DIR; small, not asked for |
| M4 | M, decision | Answer, ask, inform or pass it on | judg | | | prose |
| M5 | M, question | Answer from what you know, else relay marked as relayed; a direct line for rounds | judg | | | prose |
| M6 | M, landing | Queue each landing as a `landings` step for the fleet, in the order of the turns | mech | | | code (the step commands) |
| M7 | M, landing | Check a landing against standing.md and other fleets' lanes | judg / mech (`whose`) | owners | print | code (`fleet fleets whose`) |
| M8 | M, landing | A push or deploy needs the user's first-hand word | judg | | | prose |
| M9 | M, landing | One fleet has the turn; the next is given when the one before is closed or given back | mech | landing queue | refuse | **stage 5**: `step --status current` refused while another landing is current (both) |
| M10 | M, landing | Close a landing: done, `integrated` event, standing.md, notice to the fleets touched | judg (who is touched) | | | prose |
| M11 | M, chat | A fleet that does not read its chat is told | mech | chat, watch | warn (watch) | code |
| M12 | M, said once | Answer from the ledger first (`fleet fleets show`) | judg | | | prose |
| M13 | M, said once | A wait is named by number and read at its source | mech (closed) | | warn | code (`set --now` names a closed decision, in a fleet's ledger too) |
| M14 | M, said once | A silent worker is checked, not assumed | mech | heartbeats | warn | code (watch); **stage 5**: `fleets show` marks it; prose cut |
| M15 | M, waiting | An unrecorded answer is chased with the fleet | mech | chat, ledger | warn | code (watch, stage 2); **stage 5**: the fleet's own state commands warn too |
| M16 | M, machine | Settle the gate as a turn; tell a session to stop what it left running | judg | | | prose |
| M17 | M, usage | Read the usage windows before giving a turn to work that spawns many workers | mech (reading) / judg | usage reading | print | later: `step --status current` in `landings` could print the windows; stays later until there are thresholds (L6, decided) |
| M18 | M, usage | A coordinator that reads far more than its workers write is told | mech (ratio) / judg (threshold) | spend | | later: needs a threshold (L6, decided: stays later) |
| M19 | M, stop | Tell every coordinator, give the turn back, `serve --stop` | judg | | | prose |
| M20 | M, waiting | What waits on the user is read from the fleets' ledgers (`fleet fleets waiting`), never from the manager's memory or standing.md; what the user does on a fleet's page reaches the manager's watch (`--fleets`, armed while something the manager owns or relays waits on the user) | mech | ledgers, chats, registry | print | code (2026-10-01): `fleets waiting`, `chat watch --fleets` with per-fleet cursors and a `--batch` window (both); prose: run it before saying anything waits |

## tuca-mode and its fleet playbooks

| # | Where | Rule | Kind | Data | Code | Disposition |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| T1 | T | A real task opens a playbook's todo list | judg | | | prose |
| T2 | T, coordinator lazily | The ledger only once a worker outlives a turn or lanes multiply | judg | | | prose |
| T3 | T, autonomy | A push proceeds only when it will not deploy | mech | repo, CI | refuse | code (`land-check`) |
| T4 | T, autonomy | Irreversible writes pause for Luiz | judg / mech (prune) | | refuse | code for prune (dry run by default); prose otherwise |
| T5 | T, subagents | Model by role; Fable never fans out | judg | | | prose |
| T6 | T, subagents | A code-writing worker's workspace is reused along its lane; fresh only for parallel work that could meet, experiments, comparisons | mech | | warn, refuse | **stage 5** (C22), **L9** |
| T7 | T, subagents | Pushes stay with whoever holds the landing turn | mech | landing queue | refuse | **stage 5** (C51) |
| P1 | land.md, step 2 | Take the landing turn | mech | | refuse | **stage 5**: `land-check` stops without it |
| P2 | land.md, step 7 | `@` on a fresh empty change after the push | mech | jj | warn | later: `land-check` runs before the push; a post-push check is a new command |
| P3 | workspace-prune.md | Fleet workspaces go through `fleet ws prune`; the dry run first | mech | | refuse | code (stage 4); stale lines about heartbeats and prune fixed |
| P4 | session-pickup.md | Resume a fleet from `fleet state show` | mech | | print | code |
| P5 | babysit.md | One babysitter per stack | judg | | | prose |

## SPEC open items that were rules in disguise

| Item | Rule | Fixed in |
| :-- | :-- | :-- |
| open-2 | Say success only once the write is checked | TS and Python; model and traces re-recorded from Python |
| open-3 | `roadblock --agent` names a recorded worker | TS and Python; model and traces |
| open-5 | `park` frees the parked workers' current steps (back to pending, agent kept) | TS and Python; model and traces; kept as is (L2, decided) |
| open-13 | Stamps compare as instants (numbering, answered-at, `wait`) | TS and Python |
| open-21 | `chat wait` ends when its decision closes without an answer | TS and Python (tests in both) |

## For Luiz

Rules whose mechanical half was clear but whose policy was not. Luiz decided each on 2026-10-01; his
choice follows the question.

- **L1. A message to a worker: forwarded, or read at checkpoints?** brief.md had the worker read its
  inbox at each checkpoint, and the coordinator's SKILL.md had the coordinator forward every message
  addressed to a worker by `SendMessage`: a worker heard a message twice and the coordinator paid a
  turn for each. *Decided: checkpoints and a nudge.* brief.md stays; the coordinator's watch prints `!
  worker a1 (...) has not answered #12 from user for 10 min: "...". Forward it (SendMessage a1).` once
  a message to a worker has had no `--re` from it for ten minutes (`FLEET_NUDGE_S`), each told once,
  and only then is it forwarded. Both implementations; SKILL.md's rule is one line naming the nudge.
- **L2. `park` and steps.** open-5 is fixed with the step going back to `pending` and keeping its
  agent (who last worked it); `blocked`, or clearing the agent, were the alternatives. *Decided: keep
  it.*
- **L3. Haiku.** `--model` accepts `haiku`; the coordinator's SKILL.md approves only Opus, Sonnet and
  Fable. *Decided: accepted with a warning.* `agent --model` outside the three records it and prints
  `state: a1 is recorded on haiku, outside the model policy (opus, sonnet, fable): spawning it on haiku
  needs the user's OK.` (both); the page marks the row "needs your OK".
- **L4. Decisions with a manager present.** A warning on `decision --asks user` while a manager is
  served would catch the forgotten flag, and fire on every credential. *Decided: no warning; prose.*
- **L5. Untied decisions.** A warning on a decision opened with neither `--step`, `--milestone` nor
  `--agent` would fire on most decisions the traces open today. *Decided: prose only.*
- **L6. The manager's usage rules** (M17, M18) need a threshold (how full a window, what ratio) before
  code can say anything. *Decided: stays later, until there are thresholds.*
- **L7. Lane overlap: warn or refuse, and how precise.** Overlap was read from each entry's directory
  part before any glob (`src/*.ts` met `src/a/b.ts`). *Decided: still a warning, on the exact
  intersection.* Two entries meet when some path matches both: a plain path covers itself and what is
  under it, `*`, `?` and `[...]` stay in a segment, `**` spans segments, `{a,b}` is either. So
  `src/*.ts` and `src/a/b.ts` no longer meet; `src/**` and `src/a/b.ts` do; a file and a glob that
  matches it do. Decided on the product of the globs' automata (`lanes.py`, `src/ledger/lanes.ts`),
  property-tested against matching every short path (fast-check in TS, a seeded generator in Python).
  `fleet ws list` reads a lane by the same rule.
- **L8. `--needs user` on an update.** A roadblock changed to `--needs user` needed no decision, though
  a new one did. *Decided: the same as on creation.* It is refused unless `--decision` is given or the
  roadblock already names one (both).
- **L9. Workspaces: one per worker, or fewer.** Every code-writing worker got a fresh jj workspace, and
  each paid its own setup (node_modules, a devenv shell, build caches: minutes and gigabytes in
  custom-mcp-servers); about 120 stale workspace folders piled up in `~/repos/coelhorocha`. *Decided
  (Luiz, 2026-10-01):* sequential work reuses the lane's workspace (`fleet ws add --reuse`, refused while
  its holder runs; `add` warns when an idle one covers the lane); small or coupled work stays with one
  worker; a fleet may opt into one shared working copy (`set --workspaces shared`: the coordinator's
  `default`, lanes that meet refused, the brief's shared-copy rules, integration by `fleet ws split`);
  integrating ends with `prune --apply` unless the next worker reuses the workspace, and the done warning
  names both; a fresh workspace stays right for parallel workers whose files could meet, risky experiments,
  and arena or swarm comparisons. The ledger parts (`workspace_mode`, the refusal) are in both
  implementations, with a trace and the model; the workspace commands are TypeScript's, as `fleet ws` is.
