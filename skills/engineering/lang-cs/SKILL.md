---
name: lang-cs
description: C# and .NET rules and taste for tstack, from nullable discipline and records to analyzers, Microsoft.Testing.Platform, test tools and Temporal .NET gotchas. Use when writing, reviewing or testing C# code.
paths: ["**/*.cs", "**/*.csproj", "**/*.sln", "**/*.slnx", "**/Directory.*.props", "**/*.razor"]
---

# C# and .NET

## Version target

.NET 10 (LTS, SDK 10.0.401, runtime 10.0.12) and C# 14, checked 2026-09-30. .NET 11 and C# 15 (unions, closed hierarchies) are release candidates until 2026-11-10; use neither until a project pins them. A project's pinned versions win: read `global.json` (`sdk.version`, `rollForward`, the `test` section), then `TargetFramework` in `Directory.Build.props` or the csproj, then `Directory.Packages.props`. Leave `LangVersion` unset so the TFM picks it; Microsoft's docs say never `latest`. Versions and sources: [references/sources.md](references/sources.md).

## Non-negotiables

- `<Nullable>enable</Nullable>` everywhere. The null-forgiving `!` and `#pragma warning disable` each carry a same-line comment saying why the compiler is wrong. `null!` to silence a constructor is a missing `required` or a missing constructor parameter.
- A change adds no build warnings, and `dotnet format --verify-no-changes` passes on the files it touches.
- Async all the way down. `async void` only for event handlers. `.Result`, `.Wait()` and `.GetAwaiter().GetResult()` only in `Main`, with a comment. A public async method takes `CancellationToken cancellationToken = default` last and passes it to every call that accepts one.
- Time, randomness and IDs that affect an outcome come through a seam: inject `TimeProvider` (never `DateTime.Now`/`UtcNow` in logic), inject the ID or random source.
- One `HttpClient` per remote, owned by `IHttpClientFactory` or a long-lived singleton. `new HttpClient()` per call exhausts sockets and pins stale DNS.
- `catch (Exception)` only at a boundary (handler, worker loop, `Main`) that logs once and translates. Everywhere else catch the specific type or let it propagate.
- Package versions live in `Directory.Packages.props` (central package management); a csproj `PackageReference` has no `Version`.
- Test fixtures are generated or synthetic (check-digit generators for identifiers, Bogus fakers with `StrictMode(true)`), never copied from production data.

## Taste

- **Data shape first.** Values are `sealed record`s (or `readonly record struct` when small) with `required`/`init`; classes are `sealed` unless designed for inheritance. An identifier with rules (tax ID, court number, email) is a value type with `Parse`/`TryParse` that enforces them, so the rest of the code never re-checks a string. Closed choices are enums or a sealed record hierarchy consumed by an exhaustive `switch` expression.
- **Boundaries.** Wire and storage shapes are DTOs that stop at the adapter; parse them into domain values there. `System.Text.Json` with a `JsonSerializerContext` (source generation) for new code; Newtonsoft only where an SDK forces it. Configuration is read once at startup into a typed settings record that throws on a missing key.
- **Errors.** Exceptions for defects and for failures the caller cannot handle, as named types for the failure (`LoginFailedException`, `PageDriftException`), not bare `Exception` or `InvalidOperationException` with a message the caller must parse. An outcome the caller branches on (not found, rejected, retry later) is a return value: `TryX(out T)` or a small sealed result hierarchy. Guard arguments with `ArgumentNullException.ThrowIfNull` and friends. Log where you handle, not at every layer on the way up.
- **Modules.** `internal` by default; `public` is the module's interface. File-scoped namespaces and one top-level type per file in new files. When editing an existing file, keep its brace, namespace and line-ending style.
- **Dependencies.** Constructor injection, primary constructors welcome. Register in one composition root (`Program.cs`/`Startup`); a service never calls `BuildServiceProvider()` itself. Async initialization happens at startup (`IHostedService`, `AsyncLazy`), not through sync-over-async inside a singleton factory.
- **Concurrency.** `Task`-returning APIs; `ValueTask` only on measured hot paths. `Channel<T>` for producer/consumer, `SemaphoreSlim` for async mutual exclusion, never `lock` around an `await`. Application code skips `ConfigureAwait(false)`; library code with no UI or Temporal caller may use it consistently.
- **Resources.** `await using` / `using var` for every `IDisposable`/`IAsyncDisposable` you own. Pooled resources (`NpgsqlDataSource`, `HttpClient`, SDK clients) are singletons built once.
- **Logging.** `ILogger<T>` with message templates (`"Fetched {Count} pages"`), never interpolated strings; `[LoggerMessage]` source-generated methods on hot paths. `Console.WriteLine` is output for CLIs, not logging.
- **Naming.** .NET conventions: PascalCase types and members, `_camelCase` private fields, `I` on interfaces, `Async` suffix on awaitable methods, `Try` prefix for bool-plus-out.

## Toolchain and gates

Everything ships in the SDK: the compiler, the .NET analyzers, `dotnet format`, `dotnet test`. Always the latest release of each: the SDK from the dev shell (take `dotnet-sdk_10` from nixpkgs unstable when stable lags the latest patch on the [release page](https://github.com/dotnet/core/blob/main/release-notes/10.0/README.md)), packages via `dotnet package list --outdated` (the .NET 10 noun-first form), tools via `dotnet tool update`.

```sh
dotnet build -warnaserror            # compiler, nullable and analyzer warnings
dotnet format --verify-no-changes    # whitespace, style and analyzer fixes
dotnet test                          # runner chosen by global.json
```

Strictness: `AnalysisLevel` `latest-recommended`, `EnforceCodeStyleInBuild` true (IDE rules are off in command-line builds without it), `TreatWarningsAsErrors` true, severities per rule in `.editorconfig` (`dotnet_diagnostic.CA2007.severity = none`). A repo without these gets them as their own change, not inside a feature. The props, `.editorconfig` and `global.json` templates: [references/project-setup.md](references/project-setup.md).

## Testing ladder

tstack's `tdd` skill owns the method; this maps its rungs to .NET tools.

- **Runner.** Microsoft.Testing.Platform (MTP) through `global.json` `"test": {"runner": "Microsoft.Testing.Platform"}`. Test projects are executables (`OutputType Exe`). Setup and flags: [references/project-setup.md](references/project-setup.md#test-runner).
- **Example tests.** The repo's framework wins. A new repo takes TUnit (Luiz's latest choice, MTP-only, parallel by default); xUnit v3, NUnit 4/5 and MSTest 4 also run on MTP. Assertions are the framework's own.
- **Integration.** Testcontainers for .NET (Postgres, Redis, anything with an image), Respawn to reset between tests, `WebApplicationFactory<Program>` for HTTP hosts, WireMock.Net serving captured responses for third-party HTTP.
- **Snapshot/golden.** Verify (`Verify.TUnit`, `Verify.XunitV3`, `Verify.NUnit`, `Verify.MSTest`); commit the `*.verified.*` files, never the `*.received.*` ones.
- **Property-based.** CsCheck (`Gen...Sample`), framework-agnostic; FsCheck 3 when the repo already has it.
- **Model-based/stateful.** CsCheck `SampleModelBased`; `SampleConcurrent` checks linearizability of a concurrent type.
- **Fuzzing.** SharpFuzz with libFuzzer or AFL++ on Linux, for parsers of untrusted bytes.
- **Mutation.** Stryker.NET (`dotnet-stryker`, a local tool); `--test-runner mtp` for MTP projects.
- **Deterministic simulation.** None standard. `FakeTimeProvider` (`Microsoft.Extensions.TimeProvider.Testing`) controls time; Temporal's `WorkflowEnvironment.StartTimeSkippingAsync()` runs workflows with skipped timers.

**Substitutes through seams.** A fake is a hand-written `sealed class` implementing the interface the code already depends on, recording calls and configured through `init` properties; `TimeProvider` subclasses or `FakeTimeProvider` for time. Moq and NSubstitute stay out of tests of our own modules (Moq also shipped SponsorLink email hashing in 4.20.0 to 4.20.1). `InternalsVisibleTo` is for internals that are themselves a seam (a pure parser), not a way to reach past the public interface.

## Gotchas

- **MTP vs VSTest on the .NET 10 SDK.** `dotnet.config` (`[dotnet.test.runner]`) was a preview-era opt-in removed in 10.0.100 RC2; only `global.json` counts now, found by walking up from the working directory. MTP-v2 frameworks (xunit.v3 4.x, TUnit, NUnit3TestAdapter 6) under VSTest mode fail with "Testing with VSTest target is no longer supported"; a VSTest-only project under MTP mode is an error too. One mode per solution.
- **MTP command line.** `dotnet test --solution X.slnx` / `--project`, not a positional path. Filters are per framework: `--treenode-filter` (TUnit), `--filter-trait` (xUnit v3), `--filter` (MSTest, NUnit); a mixed solution routes them through `TestingPlatformCommandLineArguments`.
- **Parallel tests on a shared database.** TUnit runs tests in parallel by default; fixtures that reset or sequence a shared database need `[NotInParallel("<key>")]`.
- **Box.** `Box.V2.Core` 10.x is the generated SDK (namespace `Box.Sdk.Gen`). The separate `Box.Sdk.Gen` 1.x package bundles BouncyCastle FIPS modules whose self-integrity check fails on the .NET 10 Lambda runtime; reference `Box.V2.Core`.
- **File-based apps** (`dotnet run script.cs`) turn off reflection-based JSON; set `JsonSerializerIsReflectionEnabledByDefault` or pass a source-generated context.
- **Globalization in containers.** Chiseled images carry no ICU; `pt-BR` dates and currency need the `-extra` image or app-local ICU, otherwise set `InvariantGlobalization`. Keep `PublishTrimmed` off for reflection-based DI and Lambda Annotations.
- **Temporal .NET workflows** must be deterministic: `Workflow.UtcNow`, `Workflow.DelayAsync`, `Workflow.RunTaskAsync`, `Workflow.WhenAnyAsync`/`WhenAllAsync`, `Workflow.NewGuid`/`Workflow.Random`; no I/O, threads or `ConfigureAwait(false)` in workflow code. Activity interface methods take no `CancellationToken` parameter (the expression-tree call would serialize it); read `ActivityExecutionContext.Current.CancellationToken`. Depth: the `temporal:temporal-developer` skill.
