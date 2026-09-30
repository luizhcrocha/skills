---
name: lang-c
description: C rules and taste for tstack (C23, GCC/Clang, sanitizers, clang-tidy, QMK keymaps). Use when writing, reviewing or testing C code.
paths: ["**/*.c", "**/*.h"]
---

# C

## Version target

C23 (ISO/IEC 9899:2024), built with GCC 16.2 or Clang/LLVM 23.1.2, the latest stable releases on 2026-09-30 ([sources](references/sources.md)). GCC defaults to `-std=gnu23` since GCC 15; Clang still defaults to `gnu17`, so name the standard in the build.

A project's pinned version wins. Read it first from `CMakeLists.txt` (`C_STANDARD`, `cmake_minimum_required`), `meson.build` (`c_std`), the Makefile's `CFLAGS`, or `compile_commands.json`. QMK builds with `-std=gnu11` and `arm-none-eabi-gcc`: in a keymap, write C11 and read [references/qmk.md](references/qmk.md) before editing.

## Non-negotiables

- **Warnings are errors at the gate.** New code compiles clean under `-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow -Wformat=2 -Wimplicit-fallthrough -Wstrict-prototypes -Wundef -Wvla` with `-Werror` in CI and dev builds. The project's own flag set wins when stricter; the full hardened set is in [references/hardening.md](references/hardening.md).
- **No undefined behaviour on purpose.** Signed overflow goes through `ckd_add`/`ckd_sub`/`ckd_mul` (`<stdckdint.h>`); every index and length is checked against its bound; no type punning outside `memcpy` or a union; no VLAs.
- **Every fallible call is checked.** Mark the project's own fallible functions `[[nodiscard]]`. Ignoring a result is an explicit `(void)` cast with a comment saying why it is safe.
- **One owner per resource, one release path.** Every allocation, handle and lock has a documented owner and is freed on every path (see Resources).
- **Bounded string and memory functions.** `snprintf`, `memcpy` with a checked size, `strnlen`; never `gets`, `strcpy`, `strcat`, `sprintf`. Secrets are wiped with `memset_explicit` (C23; `explicit_bzero` where the libc lacks it), which the optimizer cannot remove.
- **Tests run under ASan and UBSan** (`-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer`) before a change is done.
- **Escape hatches carry a reason.** A suppression names the check and the reason on the same line: `// NOLINT(bugprone-narrowing-conversions): value < 256, checked above`. A compiler suppression is a `#pragma GCC diagnostic push` / `ignored` / `pop` around the smallest region, with the reason above it.
- **Formatting is `clang-format` with the repo's `.clang-format`.** Format only the lines you touch (`git clang-format`, or `clang-format --lines`); never reformat a file you did not otherwise change.

## Taste

- **Data shape first** (tstack principles: model-the-domain, type-system-discipline, boundary-discipline). A type with invariants is an opaque struct: declared incomplete in the header (`typedef struct parser parser;`), defined in the `.c`, built only by a constructor that validates. States are an `enum`, and a `switch` over it has no `default` so `-Wswitch-enum` flags a new state. A variant is a tagged union with the tag checked on every read. Raw input (bytes, strings, argv) is parsed once at the boundary into these types; the core never re-validates.
- **Units and widths in the type.** `uint32_t`, `size_t` for sizes and counts, `ptrdiff_t` for differences, `bool` for flags. A value with a unit gets a struct or a name suffix (`timeout_ms`).
- **Errors are return values.** A function returns a status enum (`[[nodiscard]]`) and writes results through out-parameters; success is `0`/`OK`. `errno` is read only right after the libc call that set it, and translated into the module's status at the boundary. `assert` guards invariants (programmer errors), never input validation.
- **Modules.** The header is the interface: types, function prototypes, `constexpr`/`enum` constants, nothing else. Everything not in the header is `static`. Prefix public names with the module (`ringbuf_push`). Headers compile on their own and include what they use. Prefer `static inline` functions, `enum` and C23 `constexpr` objects over macros; a macro that must stay is `UPPER_CASE` and parenthesizes every argument.
- **Const and init.** `const` on every pointer parameter the function does not write through, and on locals that do not change. Initialize at declaration (`= {}` zero-initializes in C23).
- **Resources.** Pair every `x_create` with `x_destroy` (which accepts `NULL`). A function acquiring several resources uses one cleanup label at the end, releasing in reverse order, and each failure jumps there with the status set. `defer` is only a technical specification (TS 25755) today: no compiler ships it in a standard mode.
- **Concurrency.** Shared state is owned by one thread, or behind a mutex named next to the data it guards, or an `_Atomic` with the memory order stated. `<threads.h>` or pthreads, one per project. Anything concurrent gets a TSan run.
- **Naming.** `snake_case` for functions, variables and types; `UPPER_CASE` for macros and enum constants unless the repo differs. No leading underscores (reserved).

## Toolchain and gates

- **Compilers**: GCC and Clang, both warning-clean when the project supports both. `gcc -fanalyzer` is a cheap extra pass on C (it is still experimental for C++).
- **clang-tidy** (ships with LLVM, same version): a `.clang-tidy` enabling `bugprone-*`, `cert-*`, `clang-analyzer-*`, `misc-*`, `performance-*`, `portability-*` and a chosen subset of `readability-*`, with `WarningsAsErrors: '*'`. Run `clang-tidy -p build <files>` or `run-clang-tidy -p build`.
- **cppcheck** 2.22 as a second static analyser where the project already uses it.
- **compile_commands.json** feeds clangd and clang-tidy: CMake `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, Meson writes it to the build dir, Make projects use `bear -- make`. Symlink it to the repo root.
- **Navigation**: the `clangd-lsp` plugin is installed, so the LSP tool (go to definition, find references, hover types) works on C once `compile_commands.json` exists. Prefer it over grep for "who calls this".
- **Builds**: CMake 4.4 (`cmake_minimum_required(VERSION 3.25...4.4)`: CMake 4 dropped compatibility with versions below 3.5) or Meson 1.12. Set the standard per target: `set_target_properties(t PROPERTIES C_STANDARD 23 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF)`, or `c_std=c23` in Meson.
- **Latest release, always.** LLVM: `gh api repos/llvm/llvm-project/releases/latest`; GCC: gcc.gnu.org/releases.html; CMake, Meson, AFL++, Mull: their GitHub releases. On Luiz's Nix machines, take a tool from nixpkgs-unstable or upstream when stable lags.

## Testing ladder in C

tstack's `tdd` owns the method; this maps rungs to tools.

| Rung | Tool |
|---|---|
| 0 static | the warning set, clang-tidy, `-fanalyzer`, cppcheck |
| 1 example | Unity 2.7 (small, embedded-friendly) or cmocka 2.0; runner is CTest or `meson test` |
| 2 integration | real files, sockets and processes in a temp dir, same runner |
| 3 golden | output compared to a checked-in file; regenerate with an explicit flag |
| 4 property | none standard (theft is dormant since 2020): a seeded generator loop that prints its seed, or rapidcheck from a C++ test linking the C code |
| 5 model-based | the same seeded loop driving random command sequences against a trivial model (an array, a counter) |
| 6 fuzzing | libFuzzer (`LLVMFuzzerTestOneInput`, `-fsanitize=fuzzer,address,undefined`; in maintenance mode, bug fixes only) or AFL++ 5.03c (`afl-clang-fast`, runs libFuzzer harnesses too) |
| 7 mutation | Mull 0.34 (a Clang plugin; its packages cover LLVM 13 to 22, not 23 yet) |
| 8 simulation | none standard |

Coverage: `--coverage` with gcov/gcovr, or `-fprofile-instr-generate -fcoverage-mapping` with llvm-cov.

**Substitutes through seams.** A dependency the test must replace (clock, I/O, hardware) comes in as a struct of function pointers plus a context pointer (`struct clock { uint64_t (*now_ms)(void *ctx); void *ctx; };`), passed to the constructor. Link-time substitution (a fake `.c` linked into the test binary in place of the real one) is acceptable only for a platform boundary with no seam, such as a HAL. Never mock the project's own modules: no CMock, fff or `-Wl,--wrap` on your own functions.

## Gotchas

- **Clang and GCC disagree on the default standard** (gnu17 vs gnu23). Code that compiles on one can fail on the other; pass `-std=c23` explicitly.
- **C23 changed meanings.** `bool`, `true`, `false`, `static_assert` are keywords, so an old `typedef int bool` breaks; `auto` now infers a type; `void f()` means no parameters (it used to mean unprototyped); `realloc(p, 0)` is undefined.
- **`#if FOO` with `FOO` undefined is silently 0.** Use `#if defined(FOO)` or `#ifdef`, and keep `-Wundef` on.
- **`_FORTIFY_SOURCE` needs optimization** (`-O1` or higher) and does nothing at `-O0`.
- **Sanitizers do not all combine.** ASan with UBSan is the default pair; TSan and MSan each need their own build. MSan is Clang-only and reports false positives unless every linked library is instrumented.
- **`-Wconversion` on old code is loud.** Enable it on new modules first; in old code fix the warnings in the lines you touch.

## Topics

- [references/hardening.md](references/hardening.md): the OpenSSF compile and link flag set, and which to use in dev vs release.
- [references/qmk.md](references/qmk.md): QMK firmware and Luiz's keymap (`~/repos/luizhcrocha/qmk-keymap`): what differs from general C, the build and flash loop, and the keymap's traps.
- [references/sources.md](references/sources.md): versions targeted and where they were checked; `tstack:lang-refresh` keeps them current.
