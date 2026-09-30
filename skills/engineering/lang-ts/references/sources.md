# Sources

The refresher reads this table. Versions come from the npm registry (`dist-tags.latest` and its publish time), `nodejs.org/dist/index.json`, and the projects' GitHub releases, all checked on 2026-09-30.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| TypeScript | language | 7.0.2 (native `tsc`; `next` is 7.1 dev) | 2026-09-30 | https://github.com/microsoft/TypeScript/releases/tag/v7.0.2 |
| `@typescript/native-preview` | tool | 7.0.0-dev.20260707.2, stale; do not use | 2026-09-30 | https://github.com/microsoft/typescript-go/releases |
| Node.js | runtime | 24.21.0 LTS "Krypton"; 26.10.0 Current | 2026-09-30 | https://nodejs.org/dist/index.json |
| `@types/node` | library | 26.6.3 (match the runtime's major in practice) | 2026-09-30 | https://www.npmjs.com/package/@types/node |
| Vite+ (`vite-plus`, CLI `vp`) | tool | 1.0.0; bundles Vitest 5.0.1, Oxlint 1.85.0, Oxfmt 0.70.0, oxlint-tsgolint 7.0.2003, `@oxlint/plugins` 1.79.0 | 2026-09-30 | https://github.com/voidzero-dev/vite-plus/releases |
| Vitest | tool | 5.0.3 standalone | 2026-09-30 | https://github.com/vitest-dev/vitest/releases |
| Oxlint | tool | 1.86.0 standalone | 2026-09-30 | https://github.com/oxc-project/oxc/releases |
| Oxfmt | tool | 0.71.0 standalone (pre-1.0) | 2026-09-30 | https://github.com/oxc-project/oxc/releases |
| oxlint-tsgolint | tool | 7.0.2003 (type-aware lint) | 2026-09-30 | https://www.npmjs.com/package/oxlint-tsgolint |
| `@oxlint/plugins` | library | 1.86.0 latest; pin to the Oxlint that Vite+ bundles | 2026-09-30 | https://github.com/oxc-project/oxc/releases |
| anti-slop Oxlint plugin | tool | vendored copy in custom-mcp-servers (bundle dated 2026-09-26); no canonical npm package (`oxlint-plugin-anti-slop` is a 0.0.0 placeholder) | 2026-09-30 | https://github.com/dmmulroy/anti-slop (vendored copy's provenance: custom-mcp-servers `servers/case-analysis/tools/oxlint/anti-slop/UPSTREAM.md`) |
| Effect | library | 3.22.2 stable; 4.0.0-rc.118 on `rc` (Luiz's code: 4 RC) | 2026-09-30 | https://github.com/Effect-TS/effect/releases |
| `@effect/vitest` | library | 0.30.0 stable; 4.0.0-rc.118 on `rc` | 2026-09-30 | https://github.com/Effect-TS/effect/releases |
| `@effect/sql-pg` | library | 0.53.0 stable (Effect 3 line) | 2026-09-30 | https://www.npmjs.com/package/@effect/sql-pg |
| better-result | library | 3.0.1 | 2026-09-30 | https://github.com/dmmulroy/better-result |
| Zod | library | 4.6.5 | 2026-09-30 | https://github.com/colinhacks/zod/releases |
| Valibot | library | 1.5.0 (only where a repo already uses it) | 2026-09-30 | https://github.com/open-circle/valibot/releases |
| fast-check | library | 4.10.2 (`fc.commands`, `fc.modelRun`, `fc.asyncModelRun`, `fc.scheduledModelRun`, `fc.scheduler`) | 2026-09-30 | https://github.com/dubzzz/fast-check/releases, https://fast-check.dev/docs/advanced/model-based-testing/ |
| `@fast-check/vitest` | library | 0.5.0 | 2026-09-30 | https://github.com/dubzzz/fast-check/releases |
| StrykerJS (`@stryker-mutator/core`, `vitest-runner`, `typescript-checker`) | tool | 10.0.0 (vitest-runner peer: `vitest >=2`) | 2026-09-30 | https://github.com/stryker-mutator/stryker-js/releases/tag/v10.0.0 |
| Jazzer.js (`@jazzer.js/core`, `@jazzer.js/jest-runner`) | tool | 4.0.0 (2026-04-15; repo active, releases sparse; no Vitest integration) | 2026-09-30 | https://github.com/CodeIntelligenceTesting/jazzer.js/releases |
| `@cloudflare/vitest-pool-workers` | tool | 0.22.0 | 2026-09-30 | https://github.com/cloudflare/workers-sdk/releases |
| wrangler | tool | 4.145.0 | 2026-09-30 | https://github.com/cloudflare/workers-sdk/releases |
| better-sqlite3 | library | 13.0.3 | 2026-09-30 | https://github.com/WiseLibs/better-sqlite3/releases |
| drizzle-orm | library | 0.45.3 (`latest`; 1.0 betas on other tags) | 2026-09-30 | https://github.com/drizzle-team/drizzle-orm/releases |
| drizzle-kit | tool | 0.31.11 | 2026-09-30 | https://github.com/drizzle-team/drizzle-orm/releases |
| PGlite (`@electric-sql/pglite`) | library | 0.5.8 | 2026-09-30 | https://github.com/electric-sql/pglite/releases |
| TypeScript `lib` ES2025 | doc | `lib.es2025.d.ts` references `es2025.iterator` (iterator helpers) | 2026-09-30 | https://unpkg.com/typescript@6/lib/lib.es2025.d.ts |

## Luiz's repos read

- `~/repos/coelhorocha/custom-mcp-servers` (master at c7d57d8, read through `jj file show -r master`):
  - tsconfig baseline shared by all five packages: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `moduleResolution: "bundler"`, `noEmit`, target `ES2024`. Taken as the tsconfig baseline.
  - Vite+ as the only toolchain: `lint.options: { typeAware: true, typeCheck: true }`, config in `vite.config.ts`, `vp check` / `vp test`. Taken as the gate.
  - The vendored anti-slop Oxlint plugin (19 rules at `error`, plus `oxc/no-accumulating-spread`) and the `// SAFETY:` comment its `require-safety-comment-for-type-assertion` rule enforces. Taken into typescript-contracts.md and boundaries-and-parsing.md.
  - Test layout: co-located `*.test.ts`, tiers by suffix (`.recorded`, `.workers`, `.browser`, a Postgres tier behind `CR_POSTGRES=1`) as Vitest projects, `silent: "passed-only"`, doubles in `src/testing/doubles/`, no `vi.mock`. Taken into testing-and-verification.md.
  - Errors: `better-result` `Result` and `TaggedError` in the servers, Effect 4 RC `Schema.TaggedError` and `Schema.brand` in `apps/casos` and `packages/casos-contracts`; MCP tool failures as `isError` results. Matches error-handling.md.
  - Structured JSON-line telemetry from an event catalog (`src/telemetry/`). Taken into observability.md.
  - memo notes: workerd refusing a module-scope `AbortController` (Chat SDK pin), `@effect/sql-pg` and empty arrays vs PGlite, ES2024 lacking iterator-helper types, gates judged by counts. Taken as gotchas. (Its note on reading env through the generated `WorkerEnvironment` type fits cloudflare-architecture.md's typed `Env` kept at composition seams.)

## pstack merge

pstack's `typescript-best-practices` (SKILL.md and references/patterns.md, base `2eb7ed46`) was merged by hand; no file is kept verbatim, so `upstreams.toml` ignores it.

Taken:
- constructive modeling and the simplest total type → domain-modeling.md;
- the `never`-local exhaustiveness check, as the fallback when no project helper exists → domain-modeling.md;
- narrowing order, guards that verify their whole claim, `satisfies` over `as`, derived types, object arguments with the hot-path exception, refactoring an `as` away → typescript-contracts.md;
- reads that tolerate unknown fields, versioned persisted JSON → boundaries-and-parsing.md;
- structured logs with ids, no prose `console.log` → observability.md.

Rejected (Luiz's standard wins):
- `kind` as the discriminant: we use `_tag`.
- Parsers that throw (`parseAgentId` throwing `Error`), and `try/catch` around persisted-JSON parses: expected failures are typed values.
- The "earned" `as User` after hand-written property checks: parse with the schema, and keep casts for branding inside the parser with a `SAFETY:` comment.
- `function handle(input: unknown)` narrowed with `typeof`: `unknown` stays at the I/O call and goes into a schema (anti-slop bans `unknown` parameters and runtime `typeof`).
- "Mock only what you can't run locally": no module mocks or spies at all; substitutes go through seams.
- `ignoreUnknownFields` everywhere on wire formats: mutating commands reject unknown fields; only read-only vendor payloads tolerate them.
- `disable-model-invocation: true`: lang-ts is model-invocable so review, tdd and the coordinator can load it.

## Open questions

- Two error and schema stacks coexist in custom-mcp-servers (`better-result` + Zod in the servers, Effect 4 RC `Schema` in casos and contracts). Decided (Luiz, 2026-09-30): Effect 4 is the direction for new code; existing non-Effect code keeps better-result + Zod until migrated on purpose.
- effect.md names `Schema.TaggedErrorClass` while custom-mcp-servers on 4.0.0-rc.117 uses `Schema.TaggedError`. Which one does the 4 RC expose now? effect.md was audited on 4.0.0-beta.85 and not re-audited on rc.118.
- anti-slop runs only in `servers/case-analysis`; quip, casos and the packages lint with defaults, and its `effect/` rules are vendored but unregistered. Should every package register it?
- custom-mcp-servers has 16 `vi.spyOn` calls, nearly all silencing `console`; the rule bans spies. Replace them with `silent: "passed-only"` or an injected logger?
- The five tsconfigs are copies with no shared base, `lib`/`types` drift, and target `ES2024` although the anti-slop `no-array-filter-map` message recommends iterator helpers (ES2025 lib). Move to a shared base on `ES2025`?
- The repo is on Vite+ 0.2.9 (Vitest 4.1, Oxlint 1.77) and has no property tests, Drizzle or better-sqlite3; the skill's defaults for those come from coding-standards-ts, not from a repo in use.
- `throw` and `extends Error` classes remain common beside `Result`; there is no written rule in the repo for when a throw is a defect.
- Stryker's vitest-runner declares `vitest >=2`; it is untested here against the Vitest that Vite+ aliases.
