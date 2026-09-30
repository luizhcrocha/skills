# tstack: restructure plan

This repo becomes **tstack**, one Claude Code plugin served from a marketplace in
this repo. It adapts poteto's pstack (cursor/plugins@fae2c6e, `pstack/`) to
Claude Code and merges it with the skills already here. This file records the
decisions taken and the work still open. It supersedes skills.sh installs of
this repo's skills once step 1 lands.

## Decisions

| # | Decision |
|---|---|
| D1 | Plugin name `tstack`. Front-door mode `/tuca-mode` (pstack's `poteto-mode`: playbook router, principles, autonomy rules). |
| D2 | Every `/tuca-mode` session is a coordinator, **lazily**: the coordinator mindset always, the ledger and registration only once it spawns a worker or the task is multi-step. |
| D3 | The **control plane** (today's reports page / dashboard) is machine-level and always available at one stable link. It lists every coordinator session. A manager, when Luiz starts one by hand, appears on the same link. The manager no longer owns the hub. |
| D3a | The hub runs as a systemd user service from home-manager, always up. Every machine on the tailnet runs one; each computes its own local facts (pids, transcripts, liveness) and exposes a read API plus SSE. Hubs discover each other over Tailscale (tag or fixed port) and any hub serves the federated view; writes are forwarded to the owning hub. Cloud sessions are out of reach. The landing turn becomes a cross-machine lock. |
| D4 | The manager is never auto-launched. Luiz starts it. |
| D5 | claude-mem is replaced by a clean-room, OptMem-Split-style memory (`memo`): deliberate one-line notes, summary tree, fixed-size wake injected by a SessionStart hook, per-project scope keyed through `jj root` plus the origin remote. `recall` also reads the archived claude-mem DB (read-only) and `jj log`. claude-mem is disabled once memo works; its DB is archived, not deleted. OptMem has no license, so nothing is copied from it. |
| D6 | jj is the working model. A SessionStart hook injects jj hints when `.jj` exists. A new agent, **worktree-janitor**, shapes a messy `@` into a clean, described stack: split by intent (by file, or by hunk through `scripts/jj-hunk-pick`, a non-interactive diff editor), describe in the repo's commit style, absorb fixups, resolve conflicts, abandon empties, end with an empty `@`; a straight stack unless the caller asks for siblings joined by a merge (`jj parallelize`, `jj new A B`). It follows the comment-sicko pattern: an Opus persona agent with a closed leash (no content edits except conflict markers, no bookmarks or pushes, nothing immutable) and a fixed report, plus a `/worktree-janitor` lead skill that audits it mechanically (final tree identical to the starting tree, conflicts aside), restores via `jj op restore` and reruns once on failure. `/tuca-mode` calls it before landing. Land rebases the whole branch (`jj rebase -b @ -d <b>@origin`, side branches and merges carried along) and pushes without asking only when `scripts/land-check` finds the push will not deploy: the repo does not deploy on a push to that bookmark, or the stack is quiet (docs, memo notes, tooling, tests) and the repo's `[skip ci]` habit puts the marker on the head's subject. It is non-interactive (the dotfiles `sp`/`d`/`push` scripts are gum-driven and stay for Luiz). |
| D7 | Overlaps with pstack are merged one at a time, each presented to Luiz with a proposed handle and merged text. Anything with no Claude Code capability is discarded. |
| D8 | Language rules load themselves when a matching file is touched, through the skill `paths:` frontmatter (supported in Claude Code 2.1.285; no hook needed). |
| D10 | The repo's tasks run through a `justfile`; no mise, no dev shell (python3, node and jj come from the machine). |
| D9 | Testing follows a ladder chosen by risk and maturity (below), after the tdd merge. |

## Order of work

1. Plugin skeleton and marketplace; switch the install from skills.sh; current skills unchanged.
2. memo + recall; disable claude-mem.
3. `/tuca-mode` and its playbooks; jj hints hook; worktree-janitor.
4. Merges, one by one (map below), starting with tdd. Each merge adds its
   mapping to `upstreams.toml`, the manifest of upstreams (mattpocock/skills
   and pstack so far) that `just sync-upstream` 3-way merges from;
   `--list-unmapped` shows what pstack still offers.
5. Language rules (ts, go, then py/nix as they earn it).
6. Fleet: machine-level control plane, one jj workspace per worker, advisor agent, rules moved from prose into code.

## Components (design sketch)

Facts they rest on (Claude Code 2.1.285 docs): SessionStart (startup, resume,
clear, compact, fork) and Stop can inject `additionalContext`; UserPromptSubmit
and PreToolUse cannot; there is no SubagentStart; hook input carries
`session_id`, `transcript_path`, and `agent_id`/`agent_type` inside subagents;
hooks get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`.
Skills take `paths:`, `context: fork`, `model`, `effort`; plugin agents take
`model`, `effort`, `tools`, `skills`, `background`, `isolation: worktree`.
`--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` overrides the installed plugin, and
`/reload-plugins` reloads it. PreCompact is undocumented: verify before use.

**Hooks.** One `hooks/hooks.json` calling one dispatcher,
`${CLAUDE_PLUGIN_ROOT}/hooks/tstack-hook <event>` (Python, stdlib), which fans
out to small handlers and must stay under ~100 ms. Handlers: memo wake
(SessionStart), jj hints (SessionStart, when `.jj` exists), mode re-injection
(SessionStart on compact/resume, when the mode flag is set), fleet heartbeat
(PostToolUse, when `agent_id` is present and a ledger exists), memo nudge (Stop).

**`/tuca-mode`.** pstack's poteto-mode, adapted: non-negotiables, the autonomy
rules, the principle index, and a playbook router; the matched playbook's steps
are copied into the todo list verbatim, skipped steps stay with a reason.
Invoking it writes a flag in `CLAUDE_PLUGIN_DATA/sessions/<session_id>/tuca-mode`
through a `!` line in the skill (`bin/tuca-mode on`, granted by the skill's
`allowed-tools`; it runs once, at invocation). A skill-frontmatter hook was
tried and rejected: it fires on the first matching event after the skill loads,
not at invocation, and its environment lacked `CLAUDE_PLUGIN_DATA`. The skill
text stays in the conversation, and after a compaction or resume the
SessionStart hook re-injects a short summary, so the mode is sticky without a
per-turn reminder. The coordinator behaviour (D2) lives in the mode: it starts
the ledger lazily, today through the coordinator skill, later the fleet scripts.

**principles.** One skill, an index plus one file per principle (23 from
pstack, synced through `upstreams.toml`, adapted in place); model-invocable, so
a playbook or the model loads the leaf it cites.

**worktree-janitor.** `agents/worktree-janitor.md` (Opus, tools limited to
Bash, Read, Grep, Glob, and Edit for conflict markers only) and
`skills/worktree-janitor` (the lead). Details in D6.

**jj hints.** SessionStart context of about 10 lines when `.jj` exists:
detached HEAD is normal, never `git checkout/stash/commit`, history moves
belong to whoever holds the landing turn, `gh` from the main workspace, one
`jj workspace add` per worker.

**Language rules.** `lang-ts` (coding-standards-ts merged with pstack's
typescript-best-practices) with `paths: ["**/*.ts", "**/*.tsx"]`; `lang-go`
wraps JetBrains use-modern-go with `paths: ["**/*.go", "**/go.mod"]`; `lang-py`
and `lang-nix` start as a page each and grow from corrections.

**test-strategy.** The merged tdd plus the ladder below; per language, the
ladder's tools live in the `lang-*` skill (fast-check in lang-ts, rapid and
`go test -fuzz` in lang-go, Hypothesis in lang-py).

**Fleet and control plane.** Scripts move from `skills/productivity/coordinator`
to a plugin-level `fleet/` package. Changes, in order:
1. Worker liveness from the PostToolUse heartbeat (`agent_id`), replacing the
   transcript regex on "your id is X".
2. One jj workspace per worker: `fleet ws new <lane>` creates it, the ledger
   records it, `fleet ws done <lane>` removes it when the lane closes; the
   lanes stay for planning. `default` stays Luiz's, landing happens only from
   landing workspaces (`*-land`, `deploy`), one turn at a time. Workers rebase
   onto `master@origin` at each checkpoint so landing rebases stay small.
   `fleet ws prune` sweeps the rest (crashed fleets, old lanes), dry-run by
   default, deleting only on Luiz's yes (one decision on the control plane). A
   workspace is removable only when every check passes: not `default`, a
   landing or a protected workspace; no running ledger row, no heartbeat in 20
   min, no process with its cwd inside; `jj workspace update-stale` and
   `jj status` run inside it show no uncommitted work; nothing unlanded
   (`(::<ws>@ ~ ::trunk()) ~ empty()` is empty after a fetch); idle for 2 h.
   Then `jj workspace forget`, remove the directory, `jj clean` for the empty
   @ left behind. Unlanded work of an abandoned lane is kept as a local,
   never-pushed bookmark `archive/<fleet>/<lane>` recorded in the ledger;
   archives older than 30 days show up in the prune list.
3. The hub as a systemd user service (D3a), then federation across the tailnet.
4. Rules that keep being restated in prose become code (the "said once" rule,
   stale Now lines, unrecorded answers), each with a test.
5. An `advisor` agent (Opus, read-only tools, long-lived): a coordinator starts
   one per fleet when workers need judgement; workers ask it through
   SendMessage before asking the user.
The coordinator's state machine (`state.py`) gets a model-based test (rung 5)
before the refactor, so the refactor is checked against it.

**memo.** See [design/memo.md](design/memo.md).

## Overlap map (proposals, each decided in step 4)

| Theme | pstack | here | proposal |
|---|---|---|---|
| test-first | tdd | tdd | **done**: one `tdd` skill with the ladder |
| explaining | how, teach | zoom-out, teach, show-me | **done**: `how` absorbed zoom-out (model-invocable, Sonnet explorers, gotchas to memo); pstack's teach decided with `why` |
| rationale | why | - | adapt sources to our MCPs |
| parallelism | swarm, arena, orchestrate playbook, orch CLI | orchestrate, coordinator, manager | fold into fleet |
| review | interrogate, no-comments + comment-sicko | code-review, thermo-nuclear | code-review is the entry; interrogate its high-stakes mode; keep no-comments |
| design | architect, principle-* | codebase-design, improve-codebase-architecture, domain-modeling | keep ours; architect as a playbook |
| debugging | bug-fix, forensics playbooks, blast-radius | diagnosing-bugs | our loop is the bug-fix playbook; keep blast-radius |
| prose | unslop, technical-writing | writing-for-agents, caveman | keep all; unslop model-invocable |
| planning | multi-phase-plan, figure-it-out | to-spec, to-issues, triage, grilling | keep ours; figure-it-out as fallback playbook |
| session | recall, reflect, show-me-your-work, pause/pickup | handoff, wait-what | recall on memo; bro into wait-what |
| language | typescript-best-practices | coding-standards-ts, JetBrains use-modern-go | merge into lang-ts; wrap use-modern-go in lang-go |
| conflicts | - | resolving-merge-conflicts (git only) | jj-aware, or folded into worktree-janitor |

Discarded: make-bot-ui, benny automations, setup-pstack model detection
(agents carry `model:`), cursor-team-kit references (deslop → /simplify,
control-ui → claude-in-chrome), Bugbot and Origin parts of shipping/babysit.
The 23 `principle-*` skills become one `principles` skill with a file each.

## Open merges from tuca-mode

pstack skills the tuca-mode playbooks used that tstack does not have yet. Each
place marks it `(pending merge: <skill>)` and does the step inline meanwhile;
merging the skill replaces the marker with a pointer.

| pstack skill | Used by | Meanwhile |
|---|---|---|
| why | investigation | `recall`, `jj log -- <path>`, `jj file annotate` |
| architect | bug-fix, feature, refactoring | `codebase-design` and its DESIGN-IT-TWICE.md |
| arena | feature | two Opus agents in separate jj workspaces, pick or graft |
| interrogate | feature | `code-review` plus a fresh Opus reviewer told to break it |
| unslop | the reply rules | the rules inline in tuca-mode |
| no-comments | the comments rule | the rule inline in tuca-mode |
| show-me-your-work | non-negotiables, autonomous-run, hillclimb, principles/prove-it-works | a TSV decision log in the scratchpad |
| figure-it-out | the no-playbook fallback, refactoring | a bespoke step list in playbook shape |
| technical-writing | commit and PR messages | the repo's style from `jj log`, written by the worktree-janitor |
| swarm | parallel fan-out | the `orchestrate` skill |

Replaced rather than pending: poteto-agent (subagents take `model` per role),
`/deslop` (Claude Code's `/simplify`), control-ui and control-cli
(claude-in-chrome, or running the CLI), create-skill (`writing-for-agents`),
Bugbot triage (every review comment triaged on its merits), Cursor cloud agents
(background Agent calls in jj workspaces). Not in the router, moving into the
fleet (step 6): the orchestrate, autopilot-full, autopilot-stack and
multi-phase-plan playbooks; until then "run this whole project" goes to the
coordinator and orchestrate skills.

## Testing ladder (draft)

0 static (types, lint, custom lint rules) → 1 example tests at agreed seams →
2 integration on real dependencies → 3 characterization / golden →
4 property-based → 5 model-based / stateful → 6 fuzzing → 7 mutation (audit) →
8 deterministic simulation with fault injection.

Rules: pick by residual risk (invariant → property, state machine → model-based,
concurrency/crash → simulation); maturity gates the cost (prototype 0-1, core
module 4-5, rung 8 only on top of rung 5 and with nondeterminism already behind
seams); keep clock, randomness and I/O behind seams from the start; a failing
randomized test prints its seed; production assertions on invariants; report
the evidence tier reached and the one needed.
