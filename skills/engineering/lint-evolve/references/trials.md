# Trials

A trial runs one rule, alone, over every repo of Luiz's that uses its language, and writes nothing in those repos: no fix, no cache, no build output inside them, no commit. Shared by `lint-evolve` (a new rule) and `lint-audit` (measuring rules already in the packs).

## The repos

Luiz's repos are the directories under `~/repos/luizhcrocha/` and `~/repos/coelhorocha/`. Each repo counts once: a jj workspace beside its repo (`<repo>-<lane>`, whose `.jj/repo` is a file pointing at the main one) is skipped, and so is a directory with neither `.jj` nor `.git`. `lint-vendor detect --repo <dir>` names a repo's languages.

```sh
for d in ~/repos/luizhcrocha/*/ ~/repos/coelhorocha/*/; do
  [ -d "$d/.jj/repo" ] || { [ -d "$d/.git" ] && [ ! -e "$d/.jj" ]; } || continue
  printf '%s %s\n' "$d" "$(lint-vendor detect --repo "$d")"
done
```

Record the repo by its path under `~` (`~/repos/coelhorocha/custom-mcp-servers`).

## One rule, alone, per linter

`<checkout>` is the tstack checkout or workspace holding the rule. Each command reads the repo and writes to a temp dir or nowhere.

| linter | command |
|---|---|
| Oxlint (TS) | `just test-lint-ts` once in `<checkout>` (installs the harness), then write a config with `"categories": {"correctness": "off"}`, the plugin by absolute path (`{"name": "tstack", "specifier": "<checkout>/lint/ts/tstack/index.ts"}`, `anti-slop` likewise) and `"rules": {"<plugin>/<name>": "error"}`, and run `<checkout>/lint/ts/node_modules/.bin/oxlint -c <config> --format json <repo>`. Hits are `diagnostics[]` (`filename`, `labels[0].span.line`). |
| ruff | `uvx ruff@latest check --no-cache --isolated --select <CODE> --output-format concise <repo>` |
| clippy | `CARGO_TARGET_DIR=$(mktemp -d) cargo clippy --locked --workspace --all-targets --manifest-path <repo>/Cargo.toml -- -A clippy::all -W clippy::<lint>` |
| dylint | `CARGO_TARGET_DIR=$(mktemp -d) cargo dylint --path <checkout>/lint/rust/dylint/<name> --manifest-path <repo>/Cargo.toml` |
| golangci-lint | from `<repo>`: `GOLANGCI_LINT_CACHE=$(mktemp -d) golangci-lint run --no-config --enable-only <linter> ./...` |
| clang-tidy | `clang-tidy -checks='-*,<check>' -p <repo>/build <sources>` (needs the repo's `compile_commands.json`; without one, skip the repo and say so) |
| statix | a temp `statix.toml` disabling every other lint (`statix list` names them), then `statix check --config <temp> <repo>` |
| .NET analyzers | copy the repo's tracked files (`jj file list` or `git ls-files`) to a temp dir, add `dotnet_diagnostic.<ID>.severity = warning` to the copy's root `.editorconfig`, run `dotnet build -p:TreatWarningsAsErrors=false` there and count the `<ID>` warnings |

A repo whose tooling cannot run (no toolchain on this machine, a build that fails before linting) is recorded as not run, with the reason, never as zero hits.

## Judging the hits

A **true hit** is the lesson recurring: the same mistake the incident made. A **false positive** is code the rule flags that is right as it stands; quote it and say why. Hits in vendored third-party code, generated files or fixtures are neither: exclude those paths from the rule or the trial and say so. Record per repo:

```sh
lint-registry record <id> --repo ~/repos/<owner>/<repo> --hits <all hits> --false-positives <n> --note "<what the hits were>"
```
