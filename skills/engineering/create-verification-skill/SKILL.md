---
name: create-verification-skill
description: Generate a project-local verify-<app> skill that launches the app and drives it the way a user does (web, Electron, CLI, TUI, service), with a feature map, proven once. Use when a repo has no scripted way to prove behaviour on the real surface, for "make a verify skill for this repo", or when proving a change keeps meaning improvising the launch and the clicks.
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behaviour: launch it, exercise a feature the way a user would, capture evidence. This skill generates that as a project-local skill, `.claude/skills/verify-<app>/`, tailored to the repo. You write it for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app. Adapted from poteto's pstack (MIT).

Claude Code's built-in `run` skill looks for a project skill that covers launching the app before it falls back to its own per-type patterns, so a `verify-<app>` skill is also what `run` uses. Check first: a `.claude/skills/verify-*` or an equivalent project skill already present → stop and point at `tstack:maintain-verification-skill`.

## 1. Interview the repo, not the user

Answer these from the codebase; ask the user only what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI or TUI, a desktop (Electron) app, an API, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (justfile, package scripts, devenv processes, README quickstart). Note ports, env vars, seed data, auth. Secrets come through the repo's own mechanism (`secretspec run --`, `.env.example`), never pasted into the skill.
- **Drive:** how can an agent interact with it programmatically? Existing harnesses first: Playwright specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Then a generic recipe, per surface:
  - **Web UI**: claude-in-chrome (invoke the `claude-in-chrome` skill before its tools; they are deferred, so load them in one ToolSearch `select:` call). `tabs_context_mcp` then `tabs_create_mcp` for a tab of your own, `navigate`, `find` and `read_page` (accessibility tree, element refs) for stable handles, `computer` (`left_click` by `ref`, `type`, `key`, `screenshot` with `save_to_disk`), `form_input`, `get_page_text`, `read_console_messages` and `read_network_requests` for side effects, `gif_creator` to record a flow, `javascript_tool` for state a user could see but the tree hides. A scripted headless browser (Playwright) when the proof must re-run unattended.
  - **Electron**: claude-in-chrome drives Chrome, not an Electron window. When the renderer is served from a dev URL (Vite, webpack dev server), drive that URL in Chrome and say which main-process paths it skips; for the packaged app, Playwright's `_electron.launch()` from a small helper script.
  - **CLI**: direct commands with captured stdout, stderr and exit code; a disposable `HOME`/`XDG_*` or data dir per run.
  - **TUI**: a tmux session per drive (`tmux new-session -d -s verify-<id> -x 120 -y 40 '<cmd>'`, `send-keys`, `capture-pane -p`), or pexpect when prompts need waiting on.
  - **Service**: plain HTTP (`curl -sS -w '%{http_code}'`) against the port the launch owns.
- **Observe:** what evidence can be captured? Screenshots, accessibility snapshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout does not build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, marked as verification scaffolding, and remove it in cleanup.

Done when every bullet has an answer from the repo or a stated question for the user.

## 2. Generate the skill

Write `.claude/skills/verify-<app>/SKILL.md` with frontmatter: `name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it ("run", "launch", "prove", "verify" the app), so both the model and `run` find it. Then these sections, each grounded in what the interview found, no placeholder left:

- **Launch:** the exact command that starts the app for verification, and how to tell it is ready (a log line, a port answering, a prompt). Include teardown. A long-lived server starts in the background (`run_in_background` for the Bash call, or a tmux session) with its pid recorded. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated session.
- **Doctor:** one read-only check that answers "is this instance worth driving?": process up, right version or build, port owned by us, auth valid. An agent runs it first whenever anything looks off.
- **Drive:** the harness recipe with real handles from this repo, not examples. Prefer stable handles (accessible names and roles, data attributes, prompt strings, route paths) over coordinates and tab order; with claude-in-chrome, `find` or `read_page` for a `ref`, then click the ref.
- **Evidence:** what to capture for a proof and where it goes (a gitignored `artifacts/verify/<feature>/` or the session scratchpad). The proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not only the final screen; verify side effects (files written, rows inserted, messages sent) beside what is visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it skips by observing (files, network, jj or git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down what the run created. Kill what you started, by the pid or session you recorded, never by process name; close the tabs you opened (`tabs_close_mcp`). Cleanup removes instances and scratch state, never the evidence: proof artifacts survive teardown, at the location the skill names.
- **Helpers:** any script the skill ships sits in `scripts/`, is executable, and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.

Done when the file has every section filled from the repo and nothing reads `<...>`.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify (the top 3 to 5 to start, from routes, commands, menus or docs). Follow the shape in [references/feature-map-example/](references/feature-map-example/README.md): a README index and one file per feature. Each file answers, from the user's point of view, what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The example drives a fictional `control-notes` CLI; with claude-in-chrome the Drive bullets name the tool call and its handle instead (`find "New note button"`, then `computer left_click` on the ref). The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location: a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts strand no process, port or tab. A generated skill that was never executed is a draft, not a deliverable.

Done when one feature's evidence sits at the named location after cleanup, `ps` and `ss -ltnp` show nothing the run left running, and `jj status` shows no stray scaffolding.

## 5. Land it

The skill goes in as its own jj change (`jj describe -m` in the repo's style, then `jj new`); under `/tuca-mode` it lands through the Land playbook. Evidence directories stay out of it: add them to `.gitignore` in the same change.

**Reply:** the skill's path, the surface and harness it drives, the features mapped, the proof run (feature, evidence path), the change id, and `tstack:maintain-verification-skill` for keeping the map honest as the app changes. Suggest a cadence only if asked.
