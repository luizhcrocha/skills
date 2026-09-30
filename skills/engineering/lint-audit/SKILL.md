---
name: lint-audit
description: Audit tstack's lint rules against their registry and trials, then propose promotions, retirements and skill fixes and re-vendor the packs into Luiz's repos. Use for "lint audit", "audit the lint rules", a periodic run, or after a lint pack changed.
---

# Lint audit

The other half of the loop `tstack:lint-evolve` starts (docs/tstack-plan.md, D12): rules earn `error` by firing without false positives, rules that never fire leave, and a rule that keeps firing points at a skill that should teach better. The registry is `lint/registry.toml` in the tstack checkout; [lint/README.md](../../../lint/README.md) lays out the packs. `lint-registry` and `lint-vendor` are on the Bash PATH through the plugin's `bin/`.

Models: trials and repo legwork go to Sonnet agents (`general-purpose`, `model: "sonnet"`); the judgement calls in step 3 are yours.

Open a todo list with the six steps.

## 1. Report

Work in a tstack workspace of its own: `cd ~/repos/luizhcrocha/skills; jj workspace add ../skills-lint-audit -r 'trunk()' --name lint-audit` (`lint-audit-<date>` when that name is taken). Run `lint-registry validate`, `lint-registry list` and `lint-registry stale --days 90`. Done when the rules are counted per status and language, with the silent and unmeasured lists.

## 2. Measure

Trial every unmeasured rule in trial, warn or error, and every rule whose last run is older than 30 days, per [../lint-evolve/references/trials.md](../lint-evolve/references/trials.md): one Sonnet agent per language, read-only in Luiz's repos, each hit judged true or false positive. Record each run with `lint-registry record`. Done when every active rule has a run inside the last 30 days in each repo that uses its language, or a recorded reason it could not run.

## 3. Decide

Sort every active rule into one bucket:

- **Promote** trial → warn, or warn → error: runs in two or more repos, no false positive in the last 90 days. A rule with no true hit anywhere is not promoted; it goes to retire.
- **Retire**: silent for 90 days (`lint-registry stale` lists it) while its language's repos were measured. Native lints seeded from a gate stay unless Luiz says otherwise: the gate prescribes them.
- **Rework**: a false positive in the last runs. Hand it to `tstack:lint-evolve` step 5 as its own run.
- **Keeps firing**: true hits in two or more repos in the last 90 days, or more hits than the run before. The lint catches it, but the lesson is not landing where code gets written: name the skill that should teach it (the `lang-*` skill, or `tdd`, `codebase-design`...), the section, and the one-line rule it lacks, as a proposal for that skill.
- **Holds**: the rest.

Then one `AskUserQuestion` round with Luiz: promotions and retirements as multi-select options, four per question, each option naming the rule, its runs and hits. Nothing moves without his tick. Done when every active rule has a bucket and every promotion or retirement has his answer.

## 4. Apply

For each approved rule, `lint-registry set-status <id> <status> --note "<runs, hits, Luiz's yes on <date>>"`. A retired custom rule loses its code and its registration (`lint/ts/tstack/index.ts`); a retired native lint loses its line in the pack. A status move changes the pack itself only for native lints whose severity lives there (clippy levels, ruff selections); TypeScript severities come from the registry through `lint-vendor wiring`. Run `just test` and `just validate`, describe the change in the repo's style with the bucket table and the session trailer, then `jj new`. Done when the change is described and the tests pass.

## 5. Re-vendor

Find the repos that vendor packs: those of Luiz's repos (the list in trials.md) with a `tools/lint/tstack/manifest.toml`. For each where `lint-vendor --source <this workspace> --repo <repo> status` shows a newer tstack version or where a rule's severity changed, work in a jj workspace of that repo off its landing bookmark (`jj workspace add ../<repo>-lint-audit -r <bookmark>@origin --name lint-audit`), never in Luiz's working copy:

1. `lint-vendor --source <this workspace> --repo <repo workspace> update`. A conflict is left marked and reported.
2. Apply the wiring it prints that differs from the repo's config (a promoted rule's severity, a new plugin rule); keep every local override.
3. Run the repo's lint command and report the findings; app code is not changed here.
4. Describe the change in that repo's style, with the rules that moved and the lint result, then `jj new`.

Done when every vendoring repo is current or has a described change, and conflicts and lint findings are listed.

## 6. Hand over

No push, no bookmark move anywhere: each change waits for Luiz.

**Reply:** the tstack change id; the table rule | bucket | runs | hits | false positives; promotions and retirements with Luiz's answers; the keeps-firing rules with the skill, section and missing line for each; per re-vendored repo, its change id, conflicts and lint findings; rules that could not be measured and why.
