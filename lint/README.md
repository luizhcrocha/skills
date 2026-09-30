# Lint packs

Lessons that repeat become lint rules in each language's native linter (docs/tstack-plan.md, D12). A pack is the config or plugin code for one linter; it is vendored into a repo, so the repo's own checks and CI enforce it and the repo may change it.

| pack | linter | files | vendored to |
|---|---|---|---|
| `ts/` | Oxlint JS plugins | `anti-slop/` (fork of dmmulroy/anti-slop, synced through `upstreams.toml`), `tstack/` (our rules) | `tools/oxlint/anti-slop/`, `tools/oxlint/tstack/` |
| `rust/` | Clippy | `lints.toml` (`[workspace.lints]` tables), `clippy.toml` | `tools/lint/tstack/rust/` |
| `cs/` | .NET analyzers | `Directory.Build.props` (import it), `tstack.globalconfig` (severities) | `tools/lint/tstack/cs/` |
| `py/` | ruff | `ruff.toml` (the repo's config `extend`s it) | `tools/lint/tstack/py/` |
| `go/` | golangci-lint v2 | `golangci.yml` | `tools/lint/tstack/go/` |
| `c-cpp/` | clang-tidy | `.clang-tidy` | `tools/lint/tstack/c-cpp/` |
| `nix/` | statix | `statix.toml` | `tools/lint/tstack/nix/` |

Each pack is seeded only with what its `lang-*` skill's gates already prescribe. Every rule or enabled native lint has an entry in `registry.toml` (evidence, status, trial results); a line in a pack names its registry id beside it (a `.clang-tidy` group maps to `c-cpp/<group>`).

## Custom rules

- **TypeScript**: an Oxlint JS rule in `ts/tstack/rules/<id>.ts` with a RuleTester suite beside it (`<id>.test.ts`), registered in `ts/tstack/index.ts`. `just test-lint-ts` runs every suite (the anti-slop fork's too) on the Oxlint pinned in `ts/package.json`. Tests are not vendored.
- **Rust**: Clippy takes no plugins. A custom lint is a [dylint](https://github.com/trailofbits/dylint) library (`cargo dylint new <name>`, tests under `ui/` with the incident as a `.rs` file and its expected `.stderr`), kept under `rust/dylint/<name>/` and run with `cargo dylint --all`.
- **C#**: a Roslyn analyzer project; until one exists, rules are severities in `tstack.globalconfig`.
- **Python, Go, C/C++, Nix**: config only (ruff rule selection, golangci-lint linters and settings, clang-tidy checks, statix lints). A lesson none of them can express stays in the skill as prose.

Upstream anti-slop edits arrive through `just sync-upstream --upstream anti-slop`, which 3-way merges them into `ts/anti-slop/`.

## Vendoring

`lint-vendor` (on the Bash PATH through the plugin's `bin/`, or `just lint-vendor`) copies a pack into a repo at the paths above, records each file's base in `tools/lint/tstack/manifest.toml`, and later updates it by a 3-way merge so the repo's edits survive. It edits the working copy only and prints the wiring the repo still needs (oxlint `jsPlugins` and rules from the registry, `[lints] workspace = true`, the ruff `extend`...). `lint-vendor --help` has the merge rules. aimgr's `tstack-lint` package runs it on `aimgr use` and `aimgr up`.
