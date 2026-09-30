---
name: lang-go
description: "Go rules and taste for tstack: defers modern idioms to JetBrains' use-modern-go, adds gates, errors, seams and the testing ladder (rapid, go test -fuzz, synctest). Use when writing, reviewing or testing Go code."
paths: ["**/*.go", "**/go.mod"]
---

# lang-go

## Version target

Go 1.27 (go1.27.1), golangci-lint v2.14.0, staticcheck 2026.2.1, gofumpt v0.12.0, rapid v1.3.0, checked 2026-09-30 ([sources](references/sources.md)).

A project's pinned version wins. Read the `go` and `toolchain` lines in `go.mod` (and `go.work`) first; `go test` runs the `stdversion` vet check, which flags standard-library symbols newer than the `go` line. A Nix build pins its own toolchain (`buildGo127Module` in hum's flake), so raising `go.mod`'s `go` line can break `nix build` even when `go build` passes.

## Modern idioms come from use-modern-go

JetBrains' `use-modern-go` skill (plugin `modern-go-guidelines`) is the source of truth for which idioms the target Go version allows, including idioms newer than the model's training. Before editing a Go file, load that skill and follow it: run its wrapper's `list --file-path <file>` (it resolves the version from `go.mod`), read the whole output, and `explain <id>` before skipping a guideline that looks relevant. If the skill is not loaded, find the wrapper with `find ~/.claude/plugins -path '*use-modern-go/scripts/run-tool.sh'`. This skill states nothing about idioms; where the two seem to disagree on style, use-modern-go wins.

`go fix ./...` (Go 1.26 and later) applies the toolchain's modernizers mechanically; run it on the packages you touched and review the result with `jj diff` before keeping it.

## Non-negotiables

- `gofmt` (or the repo's formatter) is clean, `go vet ./...` passes, the repo's linter passes, and `go test ./...` passes before a change is done.
- Every error is handled or returned. Wrap with context as it crosses a layer: `fmt.Errorf("load config %s: %w", path, err)`. Discarding one is written `_ = f.Close()` with the reason in a comment.
- Compare errors with `errors.Is` / `errors.As` (or use-modern-go's newer form), never with `==` on a wrapped error or on `err.Error()` text.
- `panic` only for a programmer error that cannot happen (an impossible `switch` default); a library never panics on bad input.
- Every goroutine has an owner that waits for it and a way to stop it (`context`, a closed channel). Nothing is started that cannot be shut down.
- A suppression names its linter and reason: `//nolint:gosec // the path comes from a constant`.

## Taste

- **Data shape first** (`principles/model-the-domain`, `type-system-discipline`). A semantic primitive gets its own type (`type ModelID string`). Variants are a small interface with an unexported marker method or a typed `const` iota enum with a `String()`; a `switch` over them has a `default` that panics or returns an error, and `exhaustive` in golangci-lint checks it where enabled. The zero value is useful or impossible to construct by accident (unexported fields plus a `New...` constructor that validates).
- **Parse at the boundary** (`principles/boundary-discipline`). Flags, env, TOML/JSON and wire messages decode into boundary structs, then one function turns them into domain types or returns an error. Core code takes the domain types.
- **Errors.** Sentinel errors (`var ErrClosed = errors.New("ime: closed")`) for conditions callers branch on, prefixed with the package name; a custom error type only when callers need its fields. Everything else is wrapped with `%w`. hum is the reference: sentinels in `internal/inject/ime`, `errors.Is(err, context.Canceled)` at `main`.
- **Packages.** `cmd/<binary>` for mains, `internal/<concern>` for everything else, no `pkg/`. A package is named for what it provides (`capture`, `inject`), never `util` or `common`. Small interfaces live beside their consumer.
- **Seams.** A dependency the core calls (transport, engine, clock) is a small interface, defined where it is used, with a hand-written fake in the test file (`fakeTransport` in hum's `ime/session_test.go`). Build tags separate code that needs cgo or live hardware (`//go:build local`, `e2e`).
- **Concurrency.** `context.Context` is the first parameter of anything that blocks or does I/O; `signal.NotifyContext` at `main`. Goroutines plus `sync.WaitGroup` (or `errgroup` when the first error should cancel the rest), a mutex for shared state, channels for handing work over. Timeouts come from the context, not from `time.After` in a loop.
- **Resources.** `defer` the close right after the successful open. Writes that must not tear go to a temp file in the same directory, then `os.Rename`.
- **Logging.** `log/slog`, configured once in `main`; libraries take a `*slog.Logger` or use the default, and never call `log.Fatal`.
- **Naming.** Short receiver names, `MixedCaps`, initialisms upper-case (`ID`, `URL`), no `Get` prefix on getters.

## Toolchain and gates

| job | tool | how |
|---|---|---|
| format | gofmt (goimports for imports) | `gofmt -l .` must print nothing; `golangci-lint fmt` where configured |
| vet | go vet | `go vet ./...` |
| lint | golangci-lint v2 | `golangci-lint run ./...` (repo's `.golangci.yml`, `version: "2"`) |
| lint, no golangci | staticcheck | `staticcheck ./...` |
| modernize | go fix | `go fix ./...`, then review |
| test | go test | `go test ./...`, `-race` on concurrent packages |

- **Pick the linter per repo.** A repo with `.golangci.yml` or a `lint` recipe that calls golangci-lint uses golangci-lint; otherwise `go vet` plus staticcheck. gofumpt only where the repo already formats with it (neither hum nor clipse does).
- **Latest release, always.** Go from `https://go.dev/dl/?mode=json`; tools from their GitHub releases (`gh release list -R golangci/golangci-lint -L 1`). golangci-lint ships prebuilt binaries and advises against `go tool` for it; take it from nixpkgs-unstable or the release binary. Small Go tools (gremlins, staticcheck) may be pinned with a go.mod `tool` directive (`go get -tool <pkg>@latest`, run as `go tool <name>`).

## Testing ladder

tstack's `tdd` owns the method and the rungs; this maps them to tools.

| rung | tool |
|---|---|
| 0 static | gofmt, go vet, golangci-lint or staticcheck, `-race` |
| 1 example | stdlib `testing`; table tests with `t.Run(tc.name, ...)` once there are three or more cases; `cmp.Diff` from go-cmp for structs; `t.Context()` for the test's context |
| 2 integration | build tags (`//go:build e2e`) or `testing.Short()`, run against the real dependency (`just test-e2e` in hum) |
| 3 golden | files under `testdata/` with an `-update` flag (`var update = flag.Bool("update", false, "rewrite golden files")`); go-snaps where a repo already has it |
| 4 property | `pgregory.net/rapid` (`rapid.Check(t, func(t *rapid.T) {...})`, shrinking, composable generators); `testing/quick` is frozen and does not shrink |
| 5 model-based | rapid state machines: `t.Repeat(map[string]func(*rapid.T){"": checkInvariants, "put": put, ...})` against a map or slice model |
| 6 fuzzing | native `func FuzzX(f *testing.F)`, `go test -fuzz=FuzzX -fuzztime=60s ./pkg`; failures land in `testdata/fuzz/` and are committed; `f.Fuzz(rapid.MakeFuzz(prop))` reuses a rapid property |
| 7 mutation | gremlins v0.6.0 (`gremlins unleash ./...`); avito-tech/go-mutesting v2 as the alternative |
| 8 simulation | `testing/synctest` (GA since Go 1.25): `synctest.Test(t, func(t *testing.T) {...})` runs goroutines on a fake clock, `synctest.Wait` waits for them to block, Go 1.27 adds `synctest.Sleep`. Never the old `synctest.Run` |

Test helpers call `t.Helper()`. Substitutes are hand-written fakes behind the interfaces above; gomock, mockery and testify/mock stay out of our own packages, and assertions use the standard library (`if got != want { t.Fatalf(...) }`) or go-cmp rather than testify.

## Gotchas

- hum's flake overrides golangci-lint to build with Go 1.27 because staticcheck panicked on Go 1.27 IR; staticcheck 2026.2 added Go 1.27 support, so the override may now be removable (check, don't assume).
- hum is a private flake input of the dotfiles: a change reaches the machine only after push, `nix flake update hum` in dotfiles, and a switch. Changing `go.mod` or `go.sum` means recomputing `vendorHash` in dotfiles' `pkgs/hum.nix`.
- An installed hum binary does not replace the running daemon: `systemctl --user restart hum`, then confirm by a new log line.
- hum's local engine needs cgo and CUDA (`just build`, `-tags local`, explicit `CGO_LDFLAGS` for libcuda); the default dev shell sets `CGO_ENABLED=0`. `just build-cloud` and `go test ./...` need neither.
- hum's atomic config write (temp file, rename) replaces a symlinked config with a regular file.
- clipse is a fork of savedra1/clipse and keeps upstream's module path, `tests/<pkg>/` layout of external test packages, Makefile and `.golangci.yml`; Luiz's changes follow those. Its CI runs `go test -tags ci`.
- Both TUIs are on bubbletea v1 (v1.3.10); bubbletea v2 has a different API, so check `go.mod` before writing TUI code from memory.
