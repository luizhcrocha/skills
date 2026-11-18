# landmines (fork)

Forked from [interfere-inc/landmines](https://github.com/interfere-inc/landmines) (MIT, `LICENSE`) at `92084b12872103b0f9245c0325ab571df00a574b`, through `[upstream.landmines]` in tstack's `upstreams.toml`: `just sync-upstream --upstream landmines` 3-way merges upstream edits into these files.

Taken: the testing plugin (`plugins/testing.ts`, registered as `landmines-testing`) with its five rules, `lib/allowlist.ts`, and the vitest suites with `rules/rule.test-utils.ts`. `strict-msw` comes only because `plugins/testing.ts` imports it. Not taken: the style, structure and types plugins, their rules and `lib/test-owner.ts`.

## Local patches

1. `lib/allowlist.ts`: zod removed. Oxlint already validates the rule options against `allowlistSchema` (`meta.schema`), so the options are read with a type assertion, and the vendored plugin needs no runtime dependency beyond `@oxlint/plugins`.
2. `rules/no-fixed-sleep.ts`: the `sleep` message points at an injected clock first and at `vi.useFakeTimers()` only where no clock is injected (tstack's `lang-ts` references/testing-and-verification.md, review checklist).

## Tests

The suites spawn `lint/ts/node_modules/.bin/oxlint` and run under vitest (`lint/ts/run-tests.mjs`). One case, no-test-doubles' "enforces the rule through the repository config", lints with upstream's own `.oxlintrc.jsonc`, which is not here; the runner filters it out by name. Tests and `rule.test-utils.ts` are not vendored into repos.
