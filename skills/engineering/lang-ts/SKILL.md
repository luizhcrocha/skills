---
name: lang-ts
description: "TypeScript rules and taste for tstack: parse at boundaries, typed failures, strict contracts, Vite+ gates, the ladder's tools, Cloudflare and Effect topics. Use when writing, reviewing or testing TypeScript code."
paths: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]
---

# TypeScript

Luiz's taste: correctness first, precise domain models, typed failures, deep modules, explicit boundaries, tests through real seams, strict and boring TypeScript. This file routes; load every topic file whose trigger matches the change. Adapted in part from poteto's pstack (MIT); [`references/sources.md`](references/sources.md) says what came from where.

## Version target

Latest stable on 2026-09-30 (rows and release notes in `references/sources.md`): TypeScript 7.0.2 (the native `tsc`), Node 24 LTS (24.21.0; 26.10.0 is Current), Vite+ 1.0.0 (`vp`, bundling Vitest 5.0.1, Oxlint 1.85.0, Oxfmt 0.70.0), fast-check 4.10.2, StrykerJS 10.0.0, Zod 4.6.5, Effect 4.0.0 (stable since 2026-09-30; move code on the 4 RC to it).

A project's pinned version wins: read `package.json` (`engines`, `packageManager`, dependencies), the lockfile and `devenv.nix` first, and `vp toolchain` for what Vite+ bundles.

## Non-negotiables

- Untrusted, serialized, persisted or framework-shaped input is parsed before core or service logic sees it, and the parse returns the refined value that flows inward. Decoded data is never trusted with `as SomeType`.
- Expected failures are visible in typed return channels (`Result`, Effect's error channel), not hidden throws or rejected promises. Catch variables are `unknown` until classified.
- Secrets never enter errors, logs, traces, metrics or snapshots; they travel as `Redacted` values.
- Type escape hatches (`as`, rare `any`) are local, hidden behind precise interfaces, and carry a `// SAFETY:` comment naming the invariant. No non-null `!`, no `as unknown as`, no `@ts-ignore`.
- Raw platform bindings and framework types stay at composition seams or in External Adapter Modules. Dependencies are explicit; ambient time, randomness and IDs do not drive service behavior.
- Promises are owned: awaited, returned, collected, or handed to explicit detached-work machinery.
- Tests prove observable behavior through module interfaces or real seams; `vi.mock` and `vi.spyOn` are out.
- `vp check` passes with zero warnings and no unused suppressions; strictness is never weakened to admit changed code.
- Broad migrations, backwards compatibility, rollout plans, backfills and dual-write paths need Luiz's explicit ask. New designs are the target state.

When local code breaks one of these, keep compatibility at the seam and improve the changed path rather than copying the violation.

## How to apply

1. Audit the local codebase until the existing choice for each touched concern (schema library, result type, error classes, test layout, logger, module layout) is identified or confirmed absent. Use it when it meets these rules.
2. Classify the change by the topics below and load every matching file.
3. Make the smallest coherent improvement: no unrequested abstractions, libraries, config layers or migrations. Name any trade-off where a rule could not be applied without a broad migration.

## Taste

- **Model the domain.** Discriminated unions on `_tag` for states, one legal field set per state; branded types created only by their parser; constructive shapes (`NonEmptyArray<T>`, start plus duration) over runtime guards; the simplest total type until a use site needs `!` or a cast; exhaustive `switch` on closed variants. No `enum`, no `Partial<T>` for commands, no mode booleans.
- **Effect 4 is the direction for new code** (Luiz, 2026-09-30): a new package, service or module uses Effect (Schema, typed errors in the error channel, services and layers; see [`references/effect.md`](references/effect.md)). Existing non-Effect code keeps `better-result` + Zod until it is migrated on purpose; don't mix the two inside one module.
- **Parse at the boundary.** One schema owns validation and the type is derived from it (Effect Schema in new and Effect code; Zod 4 where a non-Effect package already uses it). Mutating commands reject unknown fields. `unknown` lives only at the I/O call; inner functions take parsed types. Parsers are `parseX`, smart constructors `makeX`, predicates `isX`.
- **Errors are values.** `Schema` tagged errors in the Effect error channel for new code; `better-result`'s `Result` and `TaggedError` in existing non-Effect code; precise local unions at module interfaces, broad unions only near entrypoints. Throw only for defects and framework-required translation.
- **Contracts.** `readonly` by default; `satisfies` over `as`; derived types (`z.infer`, `Pick`, `ReturnType`, `typeof table.$inferSelect`) over parallel interfaces; a named input object when arguments could be swapped; `??` for defaults; `import type`; JSDoc on every export; no barrels, `utils.ts` or `namespace`.
- **Modules.** Deep modules at real seams; functional core, imperative shell; resources are created and closed in composition roots or managed layers, and no module does I/O at import time. `codebase-design` holds the vocabulary.
- **Concurrency.** The caller's `AbortSignal` in a final options object; independent work started concurrently, unbounded collections with bounded concurrency; retried commands safe to repeat; no transaction held across a network call.

## Toolchain and gates

- Vite+ owns the loop: `vp check` (Oxfmt, type-aware Oxlint with `typeCheck: true`, so it also type-checks) and `vp test`. Config lives in `vite.config.ts` (`lint`, `fmt`, `test` blocks).
- The tsconfig baseline is `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `moduleResolution: "bundler"`, `noEmit`.
- Custom lint rules are an Oxlint JS plugin at `error`: tstack's `lint/ts` pack (the anti-slop fork plus tstack's own rules), vendored with `lint-vendor add ts`; a lesson that repeats becomes a rule there through `tstack:lint-evolve`. Detail in `references/typescript-contracts.md`.
- Every tool is on its latest release: check with `npm view <package> version` (and GitHub releases for notes), and install that, never the version a template or nixpkgs carries. Under Vite+, the bundled Vitest, Oxlint and Oxfmt move with `vite-plus`.

## Testing ladder

`tstack:tdd` owns the method (rungs, seams, substitutes, seeds, evidence tiers). The TypeScript tools, and the patterns for each, are in [`references/testing-and-verification.md`](references/testing-and-verification.md):

| Rung | Tool |
|---|---|
| 0 static | `vp check`; Vitest `expectTypeOf`; anti-slop rules |
| 1 example | Vitest through `vp test`, `*.test.ts` beside the module |
| 2 integration | in-memory better-sqlite3 plus real Drizzle migrations; PGlite; `@cloudflare/vitest-pool-workers` for anything workerd |
| 3 golden | `toMatchFileSnapshot`; recorded vendor bodies (`*.recorded.test.ts`) |
| 4 property | fast-check with `@fast-check/vitest` (`test.prop`); `@effect/vitest` `it.prop` in Effect code |
| 5 model-based | fast-check `fc.commands` with `fc.modelRun` / `fc.asyncModelRun` |
| 6 fuzzing | Jazzer.js (`@jazzer.js/core`, its own CLI or Jest runner); fast-check at high `numRuns` inside Vitest |
| 7 mutation | StrykerJS with `@stryker-mutator/vitest-runner` and `@stryker-mutator/typescript-checker` |
| 8 simulation | none standard; `fc.scheduler()` / `fc.scheduledModelRun` for promise interleavings, Effect `TestClock` for time |

Substitutes come in through constructor or factory parameters, Effect layers or Worker bindings, as recording fakes in `src/testing/doubles/`. No mocking library for our own modules.

## Gotchas

- workerd refuses I/O objects built at module scope (an `AbortController`, a client): a dependency that does it breaks the Worker at load. Build them per request, or pin the dependency (custom-mcp-servers pins the Chat SDK at 4.38.1 for this).
- Iterator helpers (`.values().map(...).toArray()`) type-check only with `lib` at `ES2025` or later; `ES2024` lacks them.
- A Node-pool test proves nothing about workerd. Keep the pool-workers config's `compatibilityDate` equal to `wrangler.jsonc`'s; the test config does not read it.
- `@effect/sql-pg` on the Worker driver cannot type an empty array in `sql.in`, while PGlite accepts it: a PGlite-green test can fail on Postgres. Run the Postgres tier before a deploy that touches SQL.
- Standalone Vitest, Oxlint and Oxfmt can be ahead of what Vite+ bundles; `@effect/vitest` 4 needs Vitest 5 (Vite+ 1.0 or later), and `@oxlint/plugins` pins to the bundled Oxlint.
- `@typescript/native-preview` is a stale dev build; TypeScript 7 is `typescript@7`.
- With `exactOptionalPropertyTypes`, `field?: T` (may be absent) and `field: T | undefined` (present, maybe undefined) are different contracts.
- A test gate is judged by its counts (files and tests run), not by the absence of failures.

## Topics

| If the change touches... | Load |
|---|---|
| Shared terms: failure, boundary, domain, module, runtime vocabulary | [`references/vocabulary.md`](references/vocabulary.md) |
| Domain values, invariants, brands, value classes, state machines, optionality, exhaustiveness, constructive and total types | [`references/domain-modeling.md`](references/domain-modeling.md) |
| Expected failures, custom errors, not-found, cancellation classification, config diagnostics | [`references/error-handling.md`](references/error-handling.md) |
| Tracing, logging, telemetry, redaction, secrets | [`references/observability.md`](references/observability.md) |
| Domain, Service and External Adapter Modules, seams, dependency injection, resource ownership | [`references/designing-modules.md`](references/designing-modules.md) |
| HTTP, RPC, queue, storage or env parsing, DTOs, codecs, projections, runtime-hop payloads | [`references/boundaries-and-parsing.md`](references/boundaries-and-parsing.md) |
| Cancellation, promise ownership, concurrency, idempotency, transactions, retries, workflows | [`references/async-and-workflows.md`](references/async-and-workflows.md) |
| Tests: runner, layout, property, model-based, fuzzing, mutation, persistence and runtime tiers | [`references/testing-and-verification.md`](references/testing-and-verification.md) |
| Casts, narrowing, guards, `satisfies`, derived types, readonly, collections, spread, exports, JSDoc, toolchain and lint config | [`references/typescript-contracts.md`](references/typescript-contracts.md) |
| Workers, bindings, Durable Objects, Agents, D1, KV, R2, Queues, Workflows, service bindings | [`references/cloudflare-architecture.md`](references/cloudflare-architecture.md) |
| Effect services and layers, typed errors, Schema, `Redacted`, Effect testing, RPC | [`references/effect.md`](references/effect.md) |
