# Sources

The refresher reads this table. One row per language, toolchain, tool or library the skill makes claims about.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| .NET SDK and runtime | toolchain | 10.0.401 SDK, 10.0.12 runtime (LTS) | 2026-09-30 | https://github.com/dotnet/core/blob/main/release-notes/10.0/README.md |
| .NET release index (11.0 at RC.1, GA 2026-11-10) | toolchain | 11.0.0-rc.1 not targeted | 2026-09-30 | https://raw.githubusercontent.com/dotnet/core/main/release-notes/releases-index.json |
| C# | language | 14 (C# 15 preview with .NET 11) | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14 |
| LangVersion and Nullable defaults | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/language |
| .NET code analysis (AnalysisLevel, EnforceCodeStyleInBuild) | tool | SDK-bundled | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview |
| Analyzer severity in .editorconfig | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/configuration-options |
| MSBuild properties (AnalysisLevel values) | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props |
| dotnet format | tool | SDK-bundled | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format |
| dotnet test (VSTest vs MTP mode, global.json opt-in) | tool | SDK 10 | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-with-dotnet-test |
| dotnet.config removed in 10.0.100 RC2 | doc | n/a | 2026-09-30 | https://github.com/dotnet/sdk/issues/51283 |
| Microsoft.Testing.Platform | library | 2.4.1 | 2026-09-30 | https://www.nuget.org/packages/Microsoft.Testing.Platform |
| MTP code coverage (coverlet.MTP, Microsoft.Testing.Extensions.CodeCoverage) | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage |
| Test platforms overview (TUnit MTP-only, mixing unsupported) | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/testing/test-platforms-overview |
| TUnit | library | 1.72.4 | 2026-09-30 | https://www.nuget.org/packages/TUnit |
| xunit.v3 | library | 4.0.1 (MTP v2 only) | 2026-09-30 | https://xunit.net/docs/getting-started/v3/microsoft-testing-platform |
| NUnit | library | 5.0.0 (4.6.1 latest 4.x) | 2026-09-30 | https://www.nuget.org/packages/NUnit |
| NUnit3TestAdapter | library | 6.3.0 | 2026-09-30 | https://www.nuget.org/packages/NUnit3TestAdapter |
| MSTest / MSTest.Sdk | library | 4.4.1 | 2026-09-30 | https://www.nuget.org/packages/MSTest |
| Verify (+ Verify.TUnit, Verify.XunitV3) | library | 33.2.0 | 2026-09-30 | https://www.nuget.org/packages/Verify |
| CsCheck | library | 4.9.1 | 2026-09-30 | https://www.nuget.org/packages/CsCheck |
| FsCheck / FsCheck.Xunit.v3 | library | 3.4.0 | 2026-09-30 | https://www.nuget.org/packages/FsCheck |
| Stryker.NET (dotnet-stryker) | tool | 5.0.0 | 2026-09-30 | https://github.com/stryker-mutator/stryker-net/releases |
| Stryker.NET MTP runner | doc | n/a | 2026-09-30 | https://stryker-mutator.io/blog/stryker-net-mtp-runner/ |
| SharpFuzz | tool | 2.3.0 | 2026-09-30 | https://www.nuget.org/packages/SharpFuzz |
| Testcontainers / Testcontainers.PostgreSql | library | 4.15.0 | 2026-09-30 | https://www.nuget.org/packages/Testcontainers |
| TimeProvider | doc | .NET 8+ BCL | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview |
| Microsoft.Extensions.TimeProvider.Testing (FakeTimeProvider) | library | 10.10.0 | 2026-09-30 | https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing |
| Moq (SponsorLink in 4.20.0 to 4.20.1, removed in 4.20.2) | library | not used; 4.21.0 current | 2026-09-30 | https://github.com/devlooped/moq/releases/tag/v4.20.2 |
| NSubstitute | library | not used; 6.2.0 current | 2026-09-30 | https://www.nuget.org/packages/NSubstitute |
| Central Package Management | doc | n/a | 2026-09-30 | https://learn.microsoft.com/en-us/nuget/consume-packages/central-package-management |
| dotnet package list (noun-first, .NET 10) | tool | SDK 10 | 2026-09-30 | https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-package-list |
| Temporalio (.NET SDK) | library | 1.20.0 | 2026-09-30 | https://www.nuget.org/packages/Temporalio |
| Temporal .NET workflow constraints | doc | n/a | 2026-09-30 | https://docs.temporal.io/develop/dotnet/workflows/basics |
| Box.V2.Core (v10 = generated SDK) | library | 10.18.0 | 2026-09-30 | https://raw.githubusercontent.com/box/box-windows-sdk-v2/main/README.md |
| Box.Sdk.Gen (standalone, stale) | library | avoid; 1.12.0 last | 2026-09-30 | https://www.nuget.org/packages/Box.Sdk.Gen |

## Luiz's repos read

Read 2026-09-30, conventions generalized; no client data taken.

- `~/repos/coelhorocha/infra-monorepo` (37 projects, `.slnx`). Taken: central package management with transitive pinning; `Nullable` and `ImplicitUsings` on in every project; records with `required`/`init` in newer code; hand-written in-memory fakes and a fixed time provider; live integration tests over mocks; Serilog behind `ILogger<T>` with message templates; chiseled images with app-local ICU for culture-sensitive Lambdas and `PublishTrimmed` off with DI; the Box.V2.Core choice (memo: Box.Sdk.Gen 1.x FIPS self-check fails on the .NET 10 Lambda runtime); file-based scripts need reflection JSON switched on (memo).
- `~/repos/entropic-br/troti` (devenv with `dotnet-sdk_10`, Temporal .NET). Taken: TUnit on MTP; `TimeProvider? clock = null` injection with hand-rolled fake providers; typed exceptions named for the failure; sealed records and value-type identifiers with check-digit test generators; `CancellationToken` everywhere; Testcontainers Postgres plus Respawn, WireMock.Net, `WebApplicationFactory`; `[NotInParallel]` for shared-database fixtures (memo); Temporal activity interfaces without `CancellationToken` parameters, hand-written activity fakes, `WorkflowEnvironment.StartTimeSkippingAsync` per test session, pure-orchestration workflows.
- `~/repos/coelhorocha/process-contract`. Taken: Bogus fakers in `StrictMode(true)` that mirror upstream invariants; tests call the production entry point rather than re-implementing its filters (memo); NUnit on MTP.
- `~/repos/coelhorocha/gerador-documentos-juridico`. Taken: MSTest 4 on MTP; nothing else generalizable (a small console app).

## Open questions

- **troti's test runner opt-in.** `troti.backend/dotnet.config` sets `[dotnet.test.runner]`, the preview-era file removed in 10.0.100 RC2, and `global.json` has no `test` section. On a GA SDK `dotnet test` then runs in VSTest mode, which TUnit does not support. Not run here; check `just test` and move the setting into `global.json`.
- **Default test framework.** Four in use: xUnit v2 and NUnit 4 (infra-monorepo, both in one solution on VSTest), TUnit (troti), NUnit (process-contract), MSTest (gerador). The skill picks TUnit for new repos as the latest choice; confirm, or pick xUnit v3 for its wider ecosystem. Decided (Luiz, 2026-09-30): TUnit for new projects.
- **Warnings-as-errors and analyzers.** No repo sets `TreatWarningsAsErrors`, `AnalysisLevel` or `EnforceCodeStyleInBuild`, and only infra-monorepo has an `.editorconfig` (all severities `suggestion`/`silent`, CRLF declared while most files are LF). The skill asks for them in new repos and as a separate change elsewhere; confirm.
- **Time abstraction.** infra-monorepo wraps NodaTime in its own `ITimeProvider`; troti uses the BCL `TimeProvider`. The skill prefers `TimeProvider`, with NodaTime types for calendar and time-zone logic. Confirm whether infra-monorepo should converge.
- **Mocks.** infra-monorepo references Moq in two test projects against its stated no-mocks rule.
- **Error style.** infra-monorepo logs and rethrows at several layers and uses sync-over-async in singleton factories; troti does neither. The skill follows troti.
- **Brace and namespace style.** infra-monorepo's `.editorconfig` asks for block-scoped namespaces and indented (Whitesmiths) braces, while its newer files and troti use file-scoped namespaces and standard braces. The skill says file-scoped for new files and match the file when editing.
- **SDK roll-forward.** `latestMajor` (troti, would accept .NET 11 on release), `latestMinor` (infra-monorepo), `latestFeature` (process-contract), none (gerador). The template uses `latestFeature`.
- **Unverified.** No Microsoft doc recommends `<WarningsAsErrors>nullable</WarningsAsErrors>` specifically; Stryker.NET's MTP runner is documented as preview since 4.13 and its framework matrix is not published; SharpFuzz shows 2.3.0 on NuGet but 2.2.0 on GitHub releases.
