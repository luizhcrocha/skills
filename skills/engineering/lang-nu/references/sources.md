# lang-nu sources

The refresher reads this table, checks each source for a newer release, and updates the version in SKILL.md and here. Rows with no release feed carry what to compare instead: a tag, the Cargo.toml version or the last commit date on the default branch.

| item | kind | version targeted | checked on | source |
|---|---|---|---|---|
| Nushell | language/tool | 0.116.1 (installed on Luiz's machines: 0.115.1, from nixpkgs-unstable) | 2026-10-05 | https://github.com/nushell/nushell/releases |
| Nushell release notes | doc | 0.116.1; rules cite 0.110.0, 0.111.0, 0.114.0, 0.116.0 | 2026-10-05 | https://www.nushell.sh/blog/2026-10-04-nushell_v0_116_1.html , https://www.nushell.sh/blog/2026-09-26-nushell_v0_116_0.html , https://www.nushell.sh/blog/2026-07-04-nushell_v0_114_0.html , https://www.nushell.sh/blog/2026-02-28-nushell_v0_111_0.html |
| Coming from Bash | doc | tracks 0.116.x | 2026-10-05 | https://www.nushell.sh/book/coming_from_bash.html |
| Stdout, stderr and exit codes | doc | tracks 0.116.x (pipefail default since 0.111.0) | 2026-10-05 | https://www.nushell.sh/book/stdout_stderr_exit_codes.html |
| Running externals | doc | tracks 0.116.x | 2026-10-05 | https://www.nushell.sh/book/running_externals.html |
| Modules | doc | tracks 0.116.x (no implicit sub-module import since 0.114.0) | 2026-10-05 | https://www.nushell.sh/book/modules/using_modules.html |
| Configuration | doc | tracks 0.116.x | 2026-10-05 | https://www.nushell.sh/book/configuration.html |
| Standard library | doc | tracks 0.116.x | 2026-10-05 | https://www.nushell.sh/book/standard_library.html |
| Testing | doc | tracks 0.116.x (`std/assert`, no bundled `@test` runner) | 2026-10-05 | https://www.nushell.sh/book/testing.html |
| Style guide | doc | tracks 0.116.x | 2026-10-05 | https://www.nushell.sh/book/style_guide.html |
| Plugins | doc | plugin must match the engine's 0.116.x | 2026-10-05 | https://www.nushell.sh/book/plugins.html |
| nu --lsp, --ide-check, nu-check | tool | built into nu 0.116.1 | 2026-10-05 | https://github.com/nushell/nushell/tree/main/crates/nu-lsp |
| nufmt | tool | Cargo.toml 0.1.4, no releases or tags; last commit 2026-10-03 | 2026-10-05 | https://github.com/nushell/nufmt |
| nu-lint | tool | v1.5.0 tag (third party, tags only; built on nu 0.116.0) | 2026-10-05 | https://github.com/wvhulle/nu-lint/tags |
| nupm | tool | no releases or tags; last commit 2026-07-12 (experimental) | 2026-10-05 | https://github.com/nushell/nupm |
| tree-sitter-nu | tool | no releases or tags; last commit 2026-09-14 | 2026-10-05 | https://github.com/nushell/tree-sitter-nu |
| topiary-nushell | tool | archived 2026-08-13 (targets nu 0.111; not recommended) | 2026-10-05 | https://github.com/blindFS/topiary-nushell |
| vscode-nushell-lang | tool | v2.0.5 | 2026-10-05 | https://github.com/nushell/vscode-nushell-lang/releases |

## Luiz's repos read

- `~/repos/luizhcrocha/dotfiles`: `config/nushell/` (config.nu, env.nu, `modules/*.nu`), `docs/nushell.md` (startup order verified on 0.112.2 and 0.115.1, the vendor-autoload cache, `spawn-detached`, why secrets stay out of `$env`), `modules/shell/nushell.nix` (file-by-file out-of-store links into `~/.config/nushell`, and a second set on the Mac), `pkgs/default.nix` (`inherit (unstable) nushell`, 0.115.1, no plugins registered).

## Checked on 0.115.1, differs from the research or the Book

- On 0.115.1 a failing external piped into `lines` inside `let x = (...)` or a `for` header does not stop the script; the variable is an empty list. `^cmd | str trim`, `| collect`, `| from json` and a bare statement do stop it. No release note covers this; the skill tells agents to use `complete`.
- `nu-check file.nu` prints `false` and exits 0 on a parse error; only `--debug` exits 1. `nu --ide-check` exits 0 with errors.
- `[1;2]` evaluates to `[1]` on 0.115.1; 0.116.0 rejects it.
- `use std/testing *` on 0.115.1 exports the attributes and no `run-tests`.
- `use m` with `export module sub.nu` inside `m` gives no `m sub ...` command; `export use sub.nu` does, and `use m [sub]` gives `sub ...`.

## Open questions

- No repo of Luiz's has Nushell tests in Nushell; the dotfiles test the config from a bash script. A `tests.nu` with `std/assert` is the proposed default.
- nufmt has no release and its README badge lags; revisit it as a gate when it tags 1.0 or the Book documents a formatter.
- The machines run 0.115.1 because nixpkgs-unstable has not picked up 0.116.x; the upgrade breaks custom completers (0.116.0).
