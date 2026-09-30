# lang-go sources

The refresher reads this table, checks each source for a newer release, and updates the version in SKILL.md and here. Modern-idiom guidance is not tracked here: JetBrains' use-modern-go keeps it current.

| item | kind | version targeted | checked on | source |
|---|---|---|---|---|
| Go | language | go1.27.1 (1.27.0 on 2026-08-19; previous minor go1.26.8) | 2026-09-30 | https://go.dev/dl/?mode=json , https://go.dev/doc/devel/release , https://go.dev/doc/go1.27 |
| testing/synctest | library (stdlib) | GA since Go 1.25; `synctest.Sleep` in 1.27 | 2026-09-30 | https://go.dev/doc/go1.25 , https://go.dev/doc/go1.27 , https://pkg.go.dev/testing/synctest |
| go fix modernizers | tool | rewritten on the analysis framework in Go 1.26 | 2026-09-30 | https://go.dev/doc/go1.26 |
| use-modern-go | doc (skill) | modern-go-guidelines plugin 1.1.1 | 2026-09-30 | https://github.com/JetBrains/go-modern-guidelines (installed at `~/.claude/plugins/synced/*/modern-go-guidelines/`) |
| golang.org/x/tools (goimports, gopls) | tool | v0.50.0 (gopls v0.23.0) | 2026-09-30 | https://proxy.golang.org/golang.org/x/tools/@latest |
| golangci-lint | tool | v2.14.0 | 2026-09-30 | https://github.com/golangci/golangci-lint/releases , https://golangci-lint.run/docs/welcome/install/local/ |
| staticcheck | tool | 2026.2.1 (v0.8.1) | 2026-09-30 | https://github.com/dominikh/go-tools/releases |
| gofumpt | tool | v0.12.0 | 2026-09-30 | https://github.com/mvdan/gofumpt/releases |
| pgregory.net/rapid | library | v1.3.0 | 2026-09-30 | https://github.com/flyingmutant/rapid/releases |
| testing/quick | library (stdlib) | frozen, no new features | 2026-09-30 | https://pkg.go.dev/testing/quick |
| go-cmp | library | v0.7.0 | 2026-09-30 | https://github.com/google/go-cmp/releases |
| go-snaps | library | v0.5.23 | 2026-09-30 | https://proxy.golang.org/github.com/gkampitakis/go-snaps/@latest |
| gremlins | tool | v0.6.0 | 2026-09-30 | https://github.com/go-gremlins/gremlins/releases |
| avito-tech/go-mutesting | tool | v2.3.1 | 2026-09-30 | https://github.com/avito-tech/go-mutesting/releases |

## Luiz's repos read

- `~/repos/luizhcrocha/hum` (Luiz's own, about 43 .go): `go 1.27`, `cmd/` + `internal/` + `labs/`, justfile (`build`, `build-cloud`, `test`, `test-local`, `test-e2e`, `lint` = golangci-lint defaults), flake with `buildGo127Module`; sentinel errors, `%w` wrapping, `errors.Is`; `log/slog`; cobra; TOML config written atomically; small interfaces with hand-written fakes; stdlib tests with got/want; build tags `local` and `e2e`; bubbletea v1. Memo: daemon restart, flake input and `vendorHash`, cgo/CUDA, symlinked config replaced.
- `~/repos/luizhcrocha/clipse` (fork of savedra1/clipse): `go 1.24.0` with `toolchain go1.24.7`, flat packages, `tests/<pkg>/` external test packages, Makefile, golangci-lint v2 config with gci, revive, misspell; Luiz's commits touch search, config and app and add tests in the existing layout.

## Open questions

- hum has no `.golangci.yml` and no CI; `just lint` runs golangci-lint defaults. Adopt a config (clipse's v2 style with revive and gci)?
- Neither repo uses table tests, rapid, fuzzing or goldens yet; the ladder here is a target, not a record of habit.
- Test layout differs: co-located in hum, a separate `tests/` tree in clipse (upstream's). The skill follows each repo.
- Is hum's golangci-lint Go 1.27 override still needed now that staticcheck 2026.2 supports Go 1.27?
- hum's `docs/decisions.md` is stale per memo (items 1, 4, 9).
- The skill recommends `errgroup` where the first error should cancel the rest; neither repo uses it yet.
