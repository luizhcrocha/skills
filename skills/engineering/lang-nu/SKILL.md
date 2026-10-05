---
name: lang-nu
description: "Nushell rules and taste for tstack: bash habits that break, external failures and pipefail, typed signatures, explicit module imports, redirection, Luiz's config in the dotfiles, nu-check and std/assert. Use when writing, reviewing or testing Nushell code, or a command for Luiz's shell."
paths: ["**/*.nu", "**/*.nuon"]
---

# lang-nu

## Version target

Nushell 0.116.1 is the latest release, and Luiz's machines run it since 2026-10-05: the dotfiles build it from upstream in `pkgs/default.nix` until nixpkgs-unstable carries it, then go back to unstable's. Checked 2026-10-05 ([sources](references/sources.md)). Every rule below was run on 0.115.1 and again on 0.116.1. A rule that changed in 0.116 says so and cites the release note.

Nushell is pre-1.0 and breaks something in most minor releases. A form you remember from training data may be gone: check it with `help <command>` or `nu -n -c '<form>'` before you write it, and read the [Book](https://www.nushell.sh/book/) for the concept.

## Commands for Luiz

Nushell is Luiz's login shell on Linux and the Mac, so every command handed to him is nushell. Anything run through `$SHELL` (ssh `Match exec`, hooks, `ssh host '…'`) is parsed by nushell too: wrap sh code as `/bin/sh -c '...'`. The bash forms fail like this (0.115.1 and 0.116.1):

| bash | in nushell | write |
|---|---|---|
| `a && b` | parse error | `a; b` (a failing external already stops the script), or `try`/`complete` when b depends on a's result |
| `a \|\| b` | parse error | `try { a } catch { b }` |
| `$(cmd)` | parse error | `(cmd)`, and `$"x (cmd)"` in a string |
| `export FOO=x`, `$HOME`, `$?` | parse errors | `$env.FOO = "x"`, `$env.HOME`, `$env.LAST_EXIT_CODE` or `complete` |
| `2>&1` | parse error | `o+e>\|` to pipe both, `e>\|` for stderr only |
| `cmd > file` | **no error**: `>` is greater-than, nothing is written | `cmd out> file`, `\| save file` |
| `cmd > /dev/null 2>&1` | | `cmd o+e>\| ignore` |
| `\` line continuation, heredoc | not supported | wrap in `( … )`; raw string `r#'…'#` |
| `for f in *.md; do` | | `for f in (glob *.md) { }` |

## Non-negotiables

- **Every external failure is handled where it happens.** A failing external stops a script at a statement (pipefail is on by default since [0.111.0](https://www.nushell.sh/blog/2026-02-28-nushell_v0_111_0.html)), but not everywhere: on 0.115.1 and 0.116.1, `let x = (^cmd | lines)` and `for l in (^cmd | lines)` carry on with an empty list when `cmd` exits non-zero. Capture an external's output through `complete` and check `exit_code`:

  ```nu
  let r = (^git rev-parse HEAD | complete)
  if $r.exit_code != 0 {
      error make {msg: $"git rev-parse failed: ($r.stderr | str trim)"}
  }
  let head = ($r.stdout | str trim)
  ```

- **`complete` for externals, `try` for internal commands.** `complete` returns `{stdout, stderr, exit_code}` and keeps stderr; it does not catch an internal command's error (`ls /nope | complete` still raises). `try { } catch {|e| }` catches both, with `$e.msg` and, for an external, `$e.exit_code`; the external's stderr goes to the terminal, not into `$e`. `do -i { }` swallows a failure on purpose and says so.
- **Fail with `error make`, exit with `exit`.** `error make {msg: "...", label: {text: "...", span: (metadata $x).span}}` raises a Nushell error (exit 1 from a script); `exit N` sets a specific code. A single label goes in `label`, a list in `labels` (0.110.0).
- **Typed signatures.** Every `def` types its parameters and declares input and output types: `def slug [name: string, --max: int = 40]: nothing -> string { }`. Nushell checks pipeline input at runtime and `let x: T` annotations by default (0.114.0). `any` is a choice to justify, not a default.
- **Scripts take arguments through `def main`.** `def main [repo: path, --dry-run] { }` gets parsing, `--help` and a usage error for free; never read `$env.ARGS` or positional strings by hand. `def --wrapped` forwards unknown flags to an external untouched.
- **Write files with `save` or `out>`.** `save` refuses to overwrite: pass `-f` (or `--append`) when that is the intent.
- **Import exactly what you use.** `use std/assert`, `use std/log`, never `use std *` or `use std log` (both load the whole library). Since [0.114.0](https://www.nushell.sh/blog/2026-07-04-nushell_v0_114_0.html), `use m` no longer brings `m`'s sub-modules: the module re-exports one with `export use sub.nu`, or the caller names it, `use m [sub]`.
- **Edit Luiz's config in the dotfiles.** `~/.config/nushell/{env,config}.nu` and `modules/*.nu` are home-manager links into `~/repos/luizhcrocha/dotfiles/config/nushell/`; edit there (the repo copy is live), and a new file only appears after a switch, which Luiz runs. `docs/nushell.md` there has the verified startup order, the vendor-autoload cache and why each module exists.

## Taste

- **Structured data over text.** Use the built-in that returns a table (`ls`, `ps`, `open file.json`, `from json`, `http get`) and filter with `where`, `select`, `get`, `sort-by`. Parse an external's text once, at the edge (`lines | parse "{key}={value}"`, `from json`), and work on records after that.
- **`^` marks the external** whenever a built-in shares the name (`^ls`, `^find`, `^sort`, `^open`, `^cp`), and `%ls` forces the built-in. Pass a list with the spread operator, `^git add ...$paths`; a bare list argument is an error.
- **Output.** A command's value is its last expression; `print` shows something mid-script and `print -e` writes to stderr. `echo` returns its argument and prints nothing in the middle of a block.
- **Env scope.** `$env.X = ...` inside a `def` stays there unless it is `def --env`; `with-env {X: 1} { }` or `X=1 ^cmd` scope it to one call. Everything in `$env` is exported to every child process, so a secret kept in `$env` reaches every external; read it at the call that needs it.
- **Strings.** `$"…(expr)…"` for interpolation, `\(` for a literal paren, `r#'…'#` for text with quotes. A string variable is not a glob: `ls $pattern` with `"*.nu"` looks for a file named `*.nu`; type it `let p: glob = "*.nu"` or call `glob $p`.
- **Naming** follows the [style guide](https://www.nushell.sh/book/style_guide.html): commands and flags kebab-case, variables and parameters snake_case (kebab-case `let` is a parse error), env vars SCREAMING_SNAKE.
- **`++` joins two lists**; add one element with `append`. Optional access is `$rec.key?` or `get -o` (`-i` is deprecated).
- **NUON** (`.nuon`) is Nushell's data format: write it with `to nuon`, read it with `open`; use it for fixtures and config that Nushell reads.

## Toolchain and gates

| job | tool | how |
|---|---|---|
| parse | `nu-check` (built in) | `nu -n -c 'nu-check --debug file.nu'` exits 1 on a parse error; plain `nu-check` prints `false` and exits 0, so it is no gate. `--as-module` for a module file |
| diagnostics | `nu --ide-check` | `nu --ide-check 100 file.nu` prints JSON diagnostics; exits 0 even with errors (0.115.1 and 0.116.1), so read the output |
| LSP | `nu --lsp` | built into `nu` |
| format | nufmt | pre-1.0, no release; advisory only, never a gate |
| lint | nu-lint | third party, 1.5.0, built against nu 0.116; advisory only |

topiary-nushell is archived; do not add it. Run scripts under test with `nu -n` (no config) so they cannot lean on Luiz's `config.nu`; `nu -c` never reads the vendor autoload dirs anyway.

## Testing ladder

tstack's `tdd` owns the method and the rungs; this maps them to Nushell.

| rung | tool |
|---|---|
| 0 static | `nu-check --debug` on every changed `.nu` |
| 1 example | `use std/assert` in a standalone `tests.nu` run with `nu -n tests.nu`: `assert equal`, `assert str contains`, `assert error { … }`, each with a message. For many tests, the Book's `scope commands` pattern ([testing](https://www.nushell.sh/book/testing.html)) |
| 2 integration | run the script as a subprocess with `nu -n script.nu args` and assert on its output and exit code, from a Nushell test or the repo's own harness (the dotfiles run `tests/test-nushell-config.sh`) |
| 3 to 8 | none standard |

Not usable yet: `use std/testing *` gives the `@test`, `@before-each` and related attributes, but no runner ships with `nu` (`run-tests` lives in the nushell repo only), so `@test` commands run nowhere unless the test file calls them. `nupm test` needs a `nupm.nuon` package, and nupm says it is not ready for serious use. Seams work as in any language: pass a closure or a path in as a parameter, and the test passes a fake.

## Gotchas

- A `;` in a list literal is a parse error since 0.116.0; 0.115.1 silently dropped what follows, `[1;2]` was `[1]` ([notes](https://www.nushell.sh/blog/2026-09-26-nushell_v0_116_0.html)). Separate items with spaces, commas or newlines.
- Nested `try … finally`, and `finally` with `return`, `break` or `continue`, run in the right order only from 0.116.0 (same notes); code that may still meet 0.115.1 keeps `finally` to one level.
- 0.116.0 binds a custom completer's inputs by parameter name (`token`, `place`, `buffer`). A completer written `{|spans|}` still runs for one migration cycle; write new ones with `place`. The dotfiles rewrite carapace's completer to `{|place|}` (`modules/init-cache.nu`); fzf's `autoload/_fzf_integration.nu` still wraps it as `{|spans|}`.
- `job spawn` starts a child of the shell that dies with it; the dotfiles' `spawn-detached` (`modules/proc.nu`) is how a process outlives the shell.
- `$ans`, `$in`, `$nu`, `$env` are reserved names; `def def` and other keyword names are parse errors.
- A bare word in command position runs an external of that name; quote strings in scripts.
- Plugins must match the engine's minor version; after an upgrade, re-run `plugin add` for each. Luiz registers none today.
