---
name: lint-evolve
description: "Turn a repeated lesson into a native lint rule, tested on the real incident and trialled across Luiz's repos. Use for \"make this a lint rule\", or a finding, gotcha or MUST KILL seen twice that a linter could catch."
---

# Lint evolve

A lesson that repeats becomes a rule in the language's own linter, vendored into each repo so its checks and CI enforce it (docs/tstack-plan.md, D12; `tstack:principles`, Encode Lessons in Structure). The packs, the registry and the vendoring are laid out in the tstack checkout's [lint/README.md](../../../lint/README.md); `lint-registry` and `lint-vendor` are on the Bash PATH through the plugin's `bin/` (else `scripts/` in the checkout).

Roles ([MODELS.md](../../productivity/coordinator/MODELS.md)): evidence legwork and trials go to `general-purpose` Researchers; an Implementer writes the rule (you, or one `general-purpose` agent in that role when this session does not run the Implementer's model).

Open a todo list with the six steps.

## 1. Evidence

Collect every instance of the lesson: the bad code as it happened (repo, path, line, the change or session that wrote it) and the fix that replaced it. Each ref goes into the registry with its source prefix:

| source | where the instance is | ref |
|---|---|---|
| reflect | a Backlog item, filed as a memo `open` note | `reflect:<memo id>` |
| review, interrogate | a finding in the report, and the diff it quotes | `review:<repo> <change id>`, `interrogate:<repo> <change id>` |
| comment-sicko | a `MUST KILL` flag from `/no-comments` | `comment-sicko:<repo> <path>:<line>` |
| memo | a `gotcha` note (`memo recall <words>`) | `memo:<id>` |
| automate-me | a `mechanical: yes` pattern with its sessions | `automate-me:<session id>` |
| a repo, a skill, a session | the code, a lang-* rule, a transcript | `repo:<name> <path>:<line>`, `skill:<name> <file>`, `session:<id>` |

Read the registry first (`lint-registry list --lang <lang>`, `lint-registry show <id>`). A rule that already covers the lesson means the repo is not running it: check `lint-vendor --repo <repo> status` and its wiring, and stop there with that finding.

The bar is two independent instances (two repos, two sessions, or two unrelated files), or one instance plus a rule a `lang-*` skill already states. Done when every instance is quoted with its ref, or the lesson is sent back as a one-off with its reason.

## 2. Decide the mechanism

The strongest mechanism that fits: a type or an unrepresentable state beats a lint, and a lint beats prose. Among lints, the linter's own beats a custom rule:

- **Native lint exists** (kind `config`): look it up in the linter's catalogue: `oxlint --rules`, `ruff rule --all`, clippy's lint list (rust-lang.github.io/rust-clippy), `golangci-lint linters`, `clang-tidy --list-checks -checks='*'`, `statix list`, the .NET analyzer rule index. Enabling it is one line in `lint/<lang>/`.
- **No native lint** (kind `custom`): TypeScript gets an Oxlint JS rule in `lint/ts/tstack/rules/`; Rust a dylint library under `lint/rust/dylint/`; C# a Roslyn analyzer (a project of its own: ask Luiz before starting one). Python, Go, C/C++ and Nix take config only: a lesson their linters cannot express goes back to the `lang-*` skill as a sharper rule, and the run ends there.

Done when the engine, the kind and the rule's name are written down, with the catalogue entry for a native lint.

## 3. Author

Work in a tstack workspace of its own: `cd ~/repos/luizhcrocha/skills; jj workspace add ../skills-lint-<name> -r 'trunk()' --name lint-<name>`.

- **Custom TypeScript rule**: `lint/ts/tstack/rules/<name>.ts` in the style of its siblings and the anti-slop fork (`defineRule`, `createOnce`, a message that names the fix), registered in `lint/ts/tstack/index.ts`. Its RuleTester suite, `<name>.test.ts`, takes the incident verbatim as `invalid` cases (trimmed to the statement, one case per distinct shape) and the fix plus the near misses as `valid` ones. `just test-lint-ts` runs it.
- **Native lint**: the one line in the pack file, its registry id in a comment beside it where the format allows.
- **Registry**: `lint-registry add --id <lang>/<plugin or linter>/<name> --lang <lang> --engine <engine> --kind <kind> --summary "<what it catches>" --where <pack file> --evidence "<ref>" ...` with every ref from step 1.

Done when the suite passes on the incident (a native lint: the linter reports it on the incident's file) and `lint-registry validate` passes.

## 4. Trial

`lint-registry set-status <id> trial --note "trial across <n> repos"`, then run the rule, alone, over every repo of Luiz's that uses the language, read-only: [references/trials.md](references/trials.md) lists the repos and the command per linter. Fan out one Reader per few repos; each returns, per repo, the hits with path and line and its verdict on each (a true hit is the lesson recurring, a false positive is not, quoted with why).

Record each repo: `lint-registry record <id> --repo <path> --hits <n> --false-positives <n> --note "<what the hits were>"`. Done when every repo using the language has a run recorded.

## 5. Rework or drop

Each false positive is a `valid` case in the suite (or a narrower config) and the trial reruns on the repos it came from. A rule that keeps false positives after two reworks is dropped: `lint-registry set-status <id> retired --note "<why>"` and its code removed. Done when the last run of every repo shows no false positive, or the rule is retired.

## 6. Propose

A rule with clean trials moves to warn: `lint-registry set-status <id> warn --note "trial clean: <repos>, <hits> hits"`. Vendoring picks up warn and error rules (`lint-vendor wiring` prints them). Run `just test-changed` (the full gate runs once, in the session that lands), then describe the change in the repo's style (`jj log`): the lesson, the evidence refs, the mechanism and why it beats the others, the trial table (repo | hits | false positives), and the session trailer. `jj new`. No push, no bookmark move: landing the change is Luiz's yes. Promotion to error is `tstack:lint-audit`'s, with his explicit answer.

**Reply:** the change id and workspace, the rule and its status, the trial table, reworks or the reason it was dropped, and the repos that will get it at the next `lint-vendor update`.
