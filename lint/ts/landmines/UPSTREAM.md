# landmines (fork)

Forked from [interfere-inc/landmines](https://github.com/interfere-inc/landmines) (MIT, `LICENSE`) at `79e91992952c14b0c217b403fa416024c1929afe`, through `[upstream.landmines]` in tstack's `upstreams.toml`: `just sync-upstream --upstream landmines` 3-way merges upstream edits into these files.

Taken: the testing plugin (`plugins/testing.ts`, registered as `landmines-testing`) with its five rules, `lib/allowlist.ts`, and the vitest suites with `rules/rule.test-utils.ts`. `strict-msw` comes only because `plugins/testing.ts` imports it. Not taken: the style, structure and types plugins, their rules and `lib/test-owner.ts`.

## Local patches

1. `lib/allowlist.ts` and `rules/no-fixed-sleep.ts`: zod removed. Oxlint already validates the rule options against each rule's `meta.schema` (built from `allowlistProperties`), so the options are read with a type assertion (`allow` and `runNow` both optional, as upstream's zod schemas have them), and the vendored plugin needs no runtime dependency beyond `@oxlint/plugins`.
2. `rules/no-fixed-sleep.ts`: the `sleep` message points at an injected clock first and at `vi.useFakeTimers()` only where no clock is injected (tstack's `lang-ts` references/testing-and-verification.md, review checklist).

## Tests

The suites spawn `lint/ts/node_modules/.bin/oxlint` and run under vitest (`lint/ts/run-tests.mjs`). One case, no-test-doubles' "enforces the rule through the repository config", lints with upstream's own `.oxlintrc.jsonc`, which is not here; the runner filters it out by name. Tests and `rule.test-utils.ts` are not vendored into repos.
