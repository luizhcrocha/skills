---
name: lang-cpp
description: C++ rules and taste for tstack (C++23, Core Guidelines, RAII and ownership, std::expected, sanitizers, CMake). Use when writing, reviewing or testing C++ code.
paths: ["**/*.cpp", "**/*.cc", "**/*.cxx", "**/*.hpp", "**/*.hh", "**/*.hxx", "**/CMakeLists.txt", "**/meson.build"]
---

# C++

## Version target

C++23 (ISO/IEC 14882:2024), built with GCC 16.2, Clang/LLVM 23.1.2 or MSVC Build Tools 14.51, the latest stable releases on 2026-09-30 ([sources](references/sources.md)). C++26 is technically complete and in its DIS ballot, not yet published; its big features ship unevenly (GCC 16 has reflection behind `-freflection` and contracts; Clang has neither), so use them only in a project that pins C++26 and one compiler. GCC 16 defaults to `gnu++20`, Clang to `gnu++17`: name the standard in the build.

A project's pinned version wins. Read it first from `CMakeLists.txt` (`CMAKE_CXX_STANDARD`, `target_compile_features(t PUBLIC cxx_std_23)`), `meson.build` (`cpp_std`), `CMakePresets.json`, or `compile_commands.json`. C code in the same repo follows `tstack:lang-c`.

## Non-negotiables

- **RAII owns every resource** (Core Guidelines R.1). No naked `new`/`delete` (R.11); `std::make_unique` by default, `std::shared_ptr` only when ownership is really shared (R.21). A raw pointer or reference never owns (R.3, I.11). Locks are `std::scoped_lock`/`std::unique_lock`, never bare `lock()`/`unlock()` (CP.20).
- **Warnings are errors at the gate.** `-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow -Wnon-virtual-dtor -Wold-style-cast -Woverloaded-virtual -Wnull-dereference -Wimplicit-fallthrough -Werror` (MSVC: `/W4 /WX /permissive-`). The OpenSSF release set is in lang-c's [hardening.md](../lang-c/references/hardening.md).
- **Every object is initialized** where it is declared (ES.20, ES.22).
- **No undefined behaviour on purpose.** `std::bit_cast` rather than `reinterpret_cast` punning; no `string_view`/`span` that outlives what it views; bounds-checked access (`.at()` or a hardened library) at boundaries.
- **Hardened standard library in debug and test builds**: `-D_GLIBCXX_ASSERTIONS` (libstdc++) or `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST` (libc++). Neither changes the ABI; `_GLIBCXX_DEBUG` does.
- **Tests run under ASan and UBSan** (`-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer`) before a change is done; concurrent code also under TSan.
- **Escape hatches carry a reason**: `// NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): mmap'd header, layout checked by static_assert`. A cast that drops `const` or narrows goes through `gsl::narrow` or a checked helper, never a C-style cast.
- **Formatting is `clang-format` with the repo's `.clang-format`**, on the lines you touch only.

## Taste

- **Data shape first** (tstack principles: model-the-domain, type-system-discipline, boundary-discipline). Ids and quantities are strong types (`struct OrderId { std::uint64_t value; };`, `std::chrono` durations), not bare integers. States are `enum class`; alternatives are `std::variant` visited exhaustively; "maybe absent" is `std::optional`. A type with invariants establishes them in its constructor, or a private constructor behind a static factory returning `std::expected<T, Error>` when construction can fail on input. Raw input is parsed once at the boundary into these types.
- **Errors.** Follow the project's strategy (E.1). In new code, an expected failure is `std::expected<T, E>` with `E` an `enum class` or a small error struct, composed with `and_then`/`transform`/`or_else`; exceptions are for failures the caller cannot handle locally and for bugs at a boundary that must unwind, and never cross a C ABI. `[[nodiscard]]` on every function whose result must be looked at.
- **Classes.** Rule of zero: members that manage themselves, no hand-written special members. If one is needed, define or `= delete` all five (C.21). Polymorphic bases get a public virtual or protected non-virtual destructor; overriders say `override`, leaves say `final`. Single-argument constructors are `explicit`.
- **Interfaces.** Read-only parameters by `const&` (or by value when cheap to copy); sinks by value and moved; views as `std::span`/`std::string_view` parameters, never stored. Ownership transfer is visible in the signature: `std::unique_ptr<T>` by value (R.32); a smart pointer parameter only when the function is about lifetime (R.30).
- **Const and compile time.** `const` by default (Con.1), `constexpr` and `consteval` where the value is known at compile time, `static_assert` for layout and size assumptions.
- **Modules and visibility.** A header declares the interface; internals live in an anonymous namespace in the `.cpp`. Pimpl only at an ABI boundary. C++20 modules only when the build supports them (CMake 3.28+ with a Ninja or Visual Studio generator); `import std` is still experimental in CMake 4.4.
- **Concurrency.** `std::jthread`, never `detach()` (CP.26); several mutexes through one `std::scoped_lock` (CP.21); no call into unknown code while holding a lock (CP.22); atomics with the memory order written out.
- **Naming.** The repo's `.clang-tidy` `readability-identifier-naming` wins; with none, match the surrounding code.

## Toolchain and gates

- **clang-tidy** (LLVM 23): `bugprone-*`, `cppcoreguidelines-*`, `modernize-*`, `performance-*`, `misc-*`, `clang-analyzer-*`, a chosen subset of `readability-*`, with `WarningsAsErrors: '*'`. The Core Guidelines ownership rules are enforced by `cppcoreguidelines-owning-memory`, `-no-malloc`, `-init-variables`, `-special-member-functions`, `-pro-type-*` and `-pro-bounds-*`.
- **GSL** (microsoft/GSL 5.0) for `gsl::not_null`, `gsl::narrow` and `gsl::owner` when the project uses it.
- **compile_commands.json** (CMake `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, Meson's build dir) feeds clang-tidy and clangd. The `clangd-lsp` plugin is installed: use the LSP tool for definitions, references and types instead of grep.
- **Builds**: CMake 4.4 (targets and `target_*` commands only, no global `include_directories`/`add_definitions`; `cmake_minimum_required(VERSION 3.28...4.4)`) with presets, or Meson 1.12. Dependencies through vcpkg (date-tagged releases) or Conan 2.
- **Latest release, always.** LLVM: `gh api repos/llvm/llvm-project/releases/latest`; GCC: gcc.gnu.org/releases.html; the rest from their GitHub releases. On Luiz's Nix machines, take a tool from nixpkgs-unstable or upstream when stable lags.
- **Lint pack**: tstack's `lint/c-cpp` (`.clang-tidy`), vendored with `lint-vendor add c-cpp`; a lesson that repeats becomes a rule there through `tstack:lint-evolve`.

## Testing ladder in C++

tstack's `tdd` owns the method; this maps rungs to tools.

| Rung | Tool |
|---|---|
| 0 static | the warning set, clang-tidy, hardened library, `static_assert` |
| 1 example | GoogleTest 1.18 or Catch2 3.16 (doctest 2.5 where header-only matters), run through CTest (`gtest_discover_tests`, `catch_discover_tests`) |
| 2 integration | real files, databases and sockets under the same runner, labelled so they can run apart |
| 3 golden | output compared to a checked-in file; regenerate with an explicit flag |
| 4 property | rapidcheck (no releases: pin a commit; has GoogleTest and Catch2 integration) or FuzzTest's `FUZZ_TEST` with domains (Clang only) |
| 5 model-based | rapidcheck's `rc::state` commands against a trivial model |
| 6 fuzzing | FuzzTest (Google's successor to libFuzzer, GoogleTest-integrated), libFuzzer (maintenance mode) or AFL++ 5.03c |
| 7 mutation | Mull 0.34 (a Clang plugin; packages for LLVM 13 to 22, not 23 yet) |
| 8 simulation | none standard |

**Substitutes through seams.** A dependency the test replaces (clock, network, storage) is an abstract interface or a concept, injected through the constructor; hand-written fakes first. GoogleMock is for those boundary interfaces only, `NiceMock` by default, `ON_CALL` for behaviour and `EXPECT_CALL` only for a real contract. Never make a method virtual just to mock it, and never mock the project's own classes: test through them.

## Gotchas

- **Defaults differ** (GCC 16 `gnu++20`, Clang `gnu++17`): code that builds on one can fail on the other.
- **Dangling views.** A `std::string_view` or `std::span` bound to a temporary (`std::string_view sv = make_string();`) dangles at the semicolon; ASan catches it only if the memory is reused.
- **`std::move` on a `const` object copies.** So does returning a `const` local.
- **`auto` and proxies**: `auto x = vec_of_bool[i];` is a proxy, not a `bool`.
- **`shared_ptr` cycles leak**; break them with `std::weak_ptr` or a clearer owner.
- **MSan needs the whole program instrumented**, the standard library included (an MSan-built libc++); without it, expect false positives. TSan and MSan each need their own build.
- **Static initialization order** across translation units is unspecified: no non-trivial globals depending on other globals; use a function-local static.

## Topics

- [references/sources.md](references/sources.md): versions targeted and where they were checked; `tstack:lang-refresh` keeps them current.
- [lang-c's hardening.md](../lang-c/references/hardening.md): the OpenSSF compile and link flags, shared by C and C++.
