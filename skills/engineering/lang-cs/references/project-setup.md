# Project setup

Templates for a repo that lacks them. Adding them to an existing repo is its own change: turning on warnings-as-errors or code style there surfaces a backlog that a feature change should not carry.

## global.json

At the repo root, beside the solution. The SDK and the test runner both resolve from it, walking up from the working directory, so run `dotnet` from the repo root or below.

```json
{
  "sdk": { "version": "10.0.401", "rollForward": "latestFeature" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

`latestFeature` accepts newer 10.0.x SDKs and refuses 11.0; `allowPrerelease` stays off unless the repo tracks a preview on purpose.

## Directory.Build.props

One copy at the root; csprojs keep only what differs.

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>
</Project>
```

`LangVersion` stays unset. `AnalysisLevel` wins over `AnalysisMode` when both are set. With `latest-all`, bulk `dotnet_analyzer_diagnostic.category-*` lines in `.editorconfig` are ignored; set rules one by one.

## Directory.Packages.props

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="TUnit" Version="1.72.4" />
  </ItemGroup>
</Project>
```

One file per repo. A nested second copy drifts; delete it. `VersionOverride` on a `PackageReference` is the documented exception and carries a comment.

## .editorconfig

Code-style (IDE) rules only run in `dotnet build` with `EnforceCodeStyleInBuild` and a severity per rule:

```ini
root = true

[*.cs]
indent_style = space
indent_size = 4
csharp_style_namespace_declarations = file_scoped:warning
dotnet_diagnostic.IDE0005.severity = warning   # unnecessary using
dotnet_diagnostic.CA2007.severity = none       # ConfigureAwait: app code and Temporal workflows
dotnet_diagnostic.CA1848.severity = suggestion # LoggerMessage delegates
```

A repo with an existing `.editorconfig` keeps its indentation, brace and line-ending choices; match them.

## Test runner

With `global.json` selecting MTP:

- Each test project is an executable (`<OutputType>Exe</OutputType>`), and `dotnet run --project Tests` runs it directly.
- Drop `Microsoft.NET.Test.Sdk`, `TestingPlatformDotnetTestSupport`, `TestingPlatformShowTestsFailure` and `TestingPlatformCaptureOutput`; they belong to the VSTest bridge.
- NUnit keeps `NUnit3TestAdapter` (6.x for MTP v2) and sets `<EnableNUnitRunner>true</EnableNUnitRunner>`; MSTest uses `MSTest.Sdk` or `<EnableMSTestRunner>true</EnableMSTestRunner>`; xunit.v3 4.x and TUnit need nothing.
- Commands: `dotnet test --solution App.slnx`, `dotnet test --project Tests/Tests.csproj`, arguments for the test app after `--` (`dotnet test -- --report-trx`, which needs `Microsoft.Testing.Extensions.TrxReport`).
- Coverage comes from an MTP extension: `coverlet.MTP` (`--coverlet`) or `Microsoft.Testing.Extensions.CodeCoverage` (`--coverage`). `coverlet.collector` is a VSTest data collector and collects nothing under MTP.

A repo still on VSTest (xUnit v2, `NUnit3TestAdapter` 5 or older) keeps VSTest mode until all its test projects move together.

## Stryker.NET

A local tool, so the version is pinned with the repo:

```sh
dotnet new tool-manifest            # once
dotnet tool install dotnet-stryker
dotnet stryker --test-runner mtp    # from the test project's directory
```

Stryker needs the .NET 10 runtime even when the project targets older.
