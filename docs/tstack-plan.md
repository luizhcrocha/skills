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
| D6 | jj is the working model. A SessionStart hook injects jj hints when `.jj` exists. A new agent, **worktree-janitor**, shapes a messy `@` into a clean, described stack: split by intent, describe in the repo's commit style, absorb fixups, resolve conflicts, abandon empties, end with an empty `@`. It follows the comment-sicko pattern: an Opus persona agent with a closed leash (no content edits except conflict markers, no bookmarks or pushes, nothing immutable) and a fixed report, plus a `/worktree-janitor` lead skill that audits it mechanically (final tree identical to the starting tree, conflicts aside), restores via `jj op restore` and reruns once on failure. `/tuca-mode` calls it before landing. It is non-interactive (the dotfiles `sp`/`d`/`push` scripts are gum-driven and stay for Luiz). |
| D7 | Overlaps with pstack are merged one at a time, each presented to Luiz with a proposed handle and merged text. Anything with no Claude Code capability is discarded. |
| D8 | Language rules load themselves when a matching file is edited (PreToolUse hook on Edit/Write mapping extension to a `lang-*` skill; `paths:` frontmatter if supported). |
| D9 | Testing follows a ladder chosen by risk and maturity (below), after the tdd merge. |

## Order of work

1. Plugin skeleton and marketplace; switch the install from skills.sh; current skills unchanged.
2. memo + recall; disable claude-mem.
3. `/tuca-mode` and its playbooks; jj hints hook; tree-butler.
4. Merges, one by one (map below), starting with tdd. Each merge adds its
   mapping to `upstreams.toml`, the manifest of upstreams (mattpocock/skills
   and pstack so far) that `mise run sync-upstream` 3-way merges from;
   `--list-unmapped` shows what pstack still offers.
5. Language rules (ts, go, then py/nix as they earn it).
6. Fleet: machine-level control plane, one jj workspace per worker, advisor agent, rules moved from prose into code.

## Overlap map (proposals, each decided in step 4)

| Theme | pstack | here | proposal |
|---|---|---|---|
| test-first | tdd | tdd | merge into `test-strategy` with the ladder |
| explaining | how, teach | zoom-out, teach, show-me | `how` absorbs zoom-out; keep teach, add diagrams |
| rationale | why | - | adapt sources to our MCPs |
| parallelism | swarm, arena, orchestrate playbook, orch CLI | orchestrate, coordinator, manager | fold into fleet |
| review | interrogate, no-comments + comment-sicko | code-review, thermo-nuclear | code-review is the entry; interrogate its high-stakes mode; keep no-comments |
| design | architect, principle-* | codebase-design, improve-codebase-architecture, domain-modeling | keep ours; architect as a playbook |
| debugging | bug-fix, forensics playbooks, blast-radius | diagnosing-bugs | our loop is the bug-fix playbook; keep blast-radius |
| prose | unslop, technical-writing | writing-for-agents, caveman | keep all; unslop model-invocable |
| planning | multi-phase-plan, figure-it-out | to-spec, to-issues, triage, grilling | keep ours; figure-it-out as fallback playbook |
| session | recall, reflect, show-me-your-work, pause/pickup | handoff, wait-what | recall on memo; bro into wait-what |
| language | typescript-best-practices | coding-standards-ts, JetBrains use-modern-go | merge into lang-ts; wrap use-modern-go in lang-go |
| conflicts | - | resolving-merge-conflicts (git only) | jj-aware, or folded into tree-butler |

Discarded: make-bot-ui, benny automations, setup-pstack model detection
(agents carry `model:`), cursor-team-kit references (deslop → /simplify,
control-ui → claude-in-chrome), Bugbot and Origin parts of shipping/babysit.
The 23 `principle-*` skills become one `principles` skill with a file each.

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
