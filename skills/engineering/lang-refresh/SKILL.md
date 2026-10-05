---
name: lang-refresh
description: Check the lang-* skills against their sources' latest releases and propose updates as jj changes. Use for "refresh the language skills", "are the lang skills current?", a new major release of a language or tool, or a scheduled run.
argument-hint: "[lang-<id> ...] [check only]"
---

# Lang refresh

Every `lang-*` skill pins what it makes claims about in `references/sources.md`: one row per language, tool, library or doc, with the version targeted, the date it was checked and the official release-notes URL. This skill checks each row for newer releases, gives a verdict per skill, and, unless the run is check only, proposes the edits as one jj change per skill for Luiz to review. Nothing is pushed and no bookmark moves.

Open a todo list with the four steps: Plan, Check, Verdict, Propose.

## 1. Plan

The checkout is `~/repos/luizhcrocha/skills` (or the workspace you run in, when it is a tstack checkout). `lang-sources` lists the rows (on the Bash PATH through the plugin's `bin/`; otherwise `scripts/lang-sources` in the checkout):

```sh
lang-sources --root <checkout> [--skill lang-c ...]
```

It prints JSON rows (`skill`, `item`, `kind`, `version`, `checked_on`, `url`, `age_days`) and names on stderr any language skill without a readable sources table; each of those is a finding for the report. `--stale DAYS` keeps rows not checked in DAYS days.

Scope is the skills Luiz names, checked whatever their dates, else every language skill; then a skill whose rows were all checked in the last 7 days is reported as current with its dates and gets no agent. Done when the in-scope skills and their rows are written down.

## 2. Check

One research agent per remaining skill, all spawned in one message: `general-purpose`, `model: "sonnet"`, `run_in_background: true`. Each brief carries the skill's path, its rows as JSON, and this, verbatim:

> For each row, find the latest stable release of the item after "version targeted", from official sources only: the registry API or the project's release notes, never a blog or memory. Look the version up first, one call per row:
> npm `https://registry.npmjs.org/<pkg>/latest`; crates.io `https://crates.io/api/v1/crates/<crate>` (send a User-Agent); PyPI `https://pypi.org/pypi/<pkg>/json`; NuGet `https://api.nuget.org/v3-flatcontainer/<id lowercased>/index.json`; Go modules `https://proxy.golang.org/<module>/@latest` (Go itself: `https://go.dev/dl/?mode=json`); GitHub `gh api repos/<owner>/<repo>/releases/latest` (authenticated; the anonymous `api.github.com` limit of 60 calls an hour runs out mid-check, so use `git ls-remote --tags` where `gh` is missing; tags or the last commit when a project has no releases); anything else, the row's URL.
> A row whose latest version equals the one targeted is current; say so in one line and move on. If every row is current, stop there and report "current".
> For a row that moved, read the official release notes or changelog for every release between the targeted version and the latest, then read the skill's SKILL.md and references/*.md and list each change that bears on a rule there: a new or changed default (a lint, a warning, a language edition), a deprecation or removal of something the skill recommends, a new tool or API the skill should name, a support window that ended. Ignore changes no rule touches.
> Report one table (item | targeted | latest | released | release-notes URL | effect), where effect is none, adopt (a rule gains or changes: say which, and the new text in one line) or breaking (a rule is now wrong: say which and why). Then the skill's verdict: current (nothing moved, or nothing that moved touches a rule), adopt, or breaking (any breaking row). Write no files.

Keep it cheap: the version lookups come first and a skill whose rows are all current costs one short agent. Done when every agent has reported or dropped out (a dropout is reported, not retried silently).

## 3. Verdict

Show Luiz one table: skill | verdict | rows moved | what changes. Under it, for each adopt or breaking skill, the proposed rule edits with their release-note URLs. A skill whose check failed is `unknown`, with the reason.

On "check only", stop here. Done when the table is shown.

## 4. Propose

Edits land in a dedicated workspace from trunk, never in Luiz's working copy:

```sh
jj workspace add ../skills-lang-refresh -r 'trunk()' --name lang-refresh
```

If the workspace exists, run `jj workspace update-stale` in it and start from `trunk()` again. Then, per skill with a verdict of adopt or breaking, one change that is a child of `trunk()` (`jj new 'trunk()'`), so Luiz can take each skill on its own:

1. Edit the rules the verdict named, in SKILL.md or its references, written through `tstack:unslop` and `tstack:writing-for-agents`.
2. In `references/sources.md`, update each checked row: version targeted, checked on (today), and the URL when the notes moved.
3. Describe it in the repo's style, the evidence in the body: `jj describe -m "lang-<id>: <what changed, in words>"`, with one line per moved row (item, old → new version, release-notes URL) and the session trailer.

Current skills share one more change off `trunk()` that only bumps their `checked on` dates: `lang-*: sources checked <date>, all current`, so the next run's staleness is right.

Run `just test-changed` in the workspace (it runs test-scripts, whose tests check that every sources table parses). Report the change ids, one line each, and leave the workspace for Luiz. Done when every changed skill has its described change and the tests pass.

## Running it periodically

Run it monthly, and by hand when a language or a major tool ships a major release (a C++ standard, a TypeScript, Go, Python, .NET, Zig, Nushell or NixOS release, a Rust edition). Both ways below leave the dotfiles alone (the daily `ai-tools-update` timer there updates tools, not these skills).

- **`/schedule`**, a cloud routine ([routines](https://code.claude.com/docs/en/routines)): it runs on Anthropic's cloud against a fresh clone of `luizhcrocha/skills`, without this machine, its jj workspaces or the installed plugin, and each run is a session listed at claude.ai/code/routines. Custom cron allows monthly (`7 9 1 * *`: the 1st at 09:07). The routine does the check-only pass, reading the skill from the clone: `/schedule monthly on the 1st at 09:07 in luizhcrocha/skills: read skills/engineering/lang-refresh/SKILL.md and follow it, check only; end with the verdict table`. Luiz reads the verdict there and runs the propose step locally when a skill comes back adopt or breaking. The routine pushes nothing.
- **`/loop`**, inside a running session on this machine ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)): `/loop 1d /tstack:lang-refresh <skill> check only` fires only while that session is open, and a recurring loop expires 7 days after it is created. It fits the week around a major release, watching one skill until its tools catch up; it cannot carry a monthly cadence.
