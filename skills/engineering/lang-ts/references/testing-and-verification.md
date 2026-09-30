# Testing and verification in TypeScript

`tstack:tdd` owns the method: the ladder and how to pick a rung, seams, substitutes through seams, determinism and seeds, evidence tiers. Call the Skill tool with "tdd" for any of those. This file maps the method onto TypeScript tools and names the TypeScript traps. Versions are in [`sources.md`](sources.md).

## Runner and layout

- Vite+ projects run tests with `vp test` and import test APIs from `vite-plus/test`. Test config lives in the `test` block of `vite.config.ts`, not in a standalone `vitest.config.ts`. Other projects use Vitest directly.
- Tests sit next to the module they cover as `x.test.ts` / `x.test.tsx`, unless the repository has another established layout.
- Tiers are named by suffix and run as Vitest `projects`, so one command picks a tier: `x.workers.test.ts` (workerd), `x.recorded.test.ts` (replayed vendor traffic), `x.browser.test.ts` (browser mode, local only), a Postgres tier behind an env switch. `vp test --project=<name>` runs one.
- `silent: "passed-only"` keeps the logs of passing tests out of the output. Use it instead of spying on `console` to silence it.
- `vi.mock`, `vi.doMock`, `vi.spyOn`, and `vi.fn` standing in for our own modules are out. Where anti-slop lint is installed, `no-module-mocking` enforces the mocks. Recording fakes come in through constructor or factory parameters, an Effect layer, or a Worker binding; shared doubles live in `src/testing/doubles/`, builders in `src/testing/builders/`.

## Rung notes

`SKILL.md` maps each rung to its tool. What the table leaves out:

- Static: `expectTypeOf` / `assertType` pin the type-level contract of exported generics. A mistake made twice becomes a rule in the Oxlint JS plugin.
- Integration: Postgres code runs on PGlite with the real migrations by default and on real Postgres behind an opt-in env switch before a deploy that touches SQL.
- Golden: recorded vendor bodies are replayed byte for byte, so their fixture files stay out of the formatter (`.jsonl`, or the `fmt` ignore list).
- Fuzzing: Jazzer.js is libFuzzer-based and has no Vitest integration; its fuzz targets run under its own CLI or Jest runner, outside `vp test`. Reach for it for parsers exposed to hostile bytes; otherwise fast-check with a high `numRuns` over hostile arbitraries does the job inside Vitest.
- Mutation: scope Stryker's `mutate` to the module under audit and run it as an occasional audit, not in the gate.
- Simulation: `fc.scheduler()` makes promise interleavings a seeded, replayable input, which covers most races in single-process code. There is no TypeScript equivalent of a deterministic whole-system simulator.

## Property tests

```ts
import { fc, test } from "@fast-check/vitest";

test.prop([emailAddressArbitrary])("normalization is idempotent", (email) => {
  expect(EmailAddress.normalize(EmailAddress.normalize(email))).toEqual(EmailAddress.normalize(email));
});
```

- Arbitraries live beside the domain module (`email-address.arbitrary.ts`) and build values through the production parser or smart constructor, or derive from the Schema. Invalid inputs get their own arbitrary, named as invalid.
- Assert with `expect` inside the callback. A property that only computes a boolean and discards it proves nothing.
- fast-check prints the seed and the shrink `path` on failure. Replay that one test with `{ seed, path }` in its parameters, or `fc.configureGlobal({ seed })`, and put the seed in the bug report.
- Schema-derived arbitraries: `Schema.toArbitrary(schema)` in Effect 4, `Arbitrary.make(schema)` in Effect 3. Effect 4 testing detail (`it.effect.prop`, version pairing) is in [`effect.md`](effect.md).

## Model-based tests

```ts
const commands = [
  fc.integer().map((amount) => new DepositCommand(amount)),
  fc.integer().map((amount) => new WithdrawCommand(amount)),
];

test.prop([fc.commands(commands)])("the ledger matches a running total", (cmds) => {
  fc.modelRun(() => ({ model: { balance: 0 }, real: new Ledger() }), cmds);
});
```

Each command class implements `check(model)`, `run(model, real)` and `toString()`; `run` applies the command to both and asserts they agree. The model stays dumb: a number, a `Map`, an array.

## Persistence and runtime

- Drizzle on SQLite without Cloudflare semantics: in-memory `better-sqlite3`, `migrate(db, { migrationsFolder })` from `drizzle-orm/better-sqlite3/migrator` before the suite, then the production adapter through its service interface.
- D1 and Durable Objects: `@cloudflare/vitest-pool-workers`, migrations read with `readD1Migrations` and applied with `applyD1Migrations` in setup. Keep the test config's `compatibilityDate` equal to `wrangler.jsonc`'s.
- A Node test proves nothing about workerd: bindings, `ctx.exports`, structured clone across RPC and service bindings, WebSockets, alarms, Workflows. Load [`cloudflare-architecture.md`](cloudflare-architecture.md) for runtime placement.

## TypeScript review checklist

- A test factory that builds branded values with `as` instead of the parser.
- Persistence tests on a hand-written fake where the claim is SQL, a constraint or a migration.
- A Worker behavior "proven" by a Node-pool test.
- Module state shared across tests, so a rejection in one test leaks into the next.
- `vi.useFakeTimers` where an injected clock is the seam.
- Snapshots of values that are not stable semantics (timestamps, ids, object key order from a `Map`).
