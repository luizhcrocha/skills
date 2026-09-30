---
name: lang-zig
description: Zig rules and taste for tstack: the 0.16 std.Io and build APIs, allocator and errdefer discipline, TigerBeetle-style assertions, and the testing ladder's Zig tools. Use when writing, reviewing or testing Zig code.
paths: ["**/*.zig", "**/build.zig", "**/build.zig.zon"]
---

# Zig

## Version target

Zig 0.16.0 (released 2026-04-13), ZLS 0.16.0, checked 2026-09-30. There is no 1.0, and every minor release breaks the standard library and the build API. A project's pinned version wins: read `.minimum_zig_version` in `build.zig.zon` (and any `.zigversion`, flake or mise pin) first, and write only what that version accepts. Written from official docs only; no Luiz repo in Zig exists yet ([references/sources.md](references/sources.md)).

Training data is mostly pre-0.15. Before writing I/O, containers, `main`, or `build.zig`, read [references/zig-0.16.md](references/zig-0.16.md); code in the old style does not compile.

## Non-negotiables

- **`zig fmt --check .` and `zig build test` pass** before a change is done. `zig fmt` is the style; do not hand-format against it.
- **Allocation is explicit.** Every function that allocates takes an `std.mem.Allocator` parameter; nothing allocates through a global. Every acquisition is followed on the next line by its `defer` release, or by `errdefer` when ownership passes to the caller on success.
- **I/O is explicit.** Anything that blocks or is nondeterministic (files, network, time, randomness, processes) takes an `std.Io` parameter (0.16). Never conjure one with `Io.Threaded.init_single_threaded` inside a library.
- **Errors are handled or returned, never swallowed.** `try` to propagate; `catch` only with a real recovery or an `unreachable` whose comment proves the error cannot occur. No `catch {}` on a fallible call.
- **`unreachable` only where a violation is a bug.** In ReleaseFast it is undefined behavior, not a panic. Runtime failures use error unions; a fatal state the program cannot recover from uses `@panic("why")`.
- **Tests use `std.testing.allocator`**, which fails the test on a leak. A leak is a failing test, not a warning.
- **Ship ReleaseSafe unless a measurement says otherwise.** Safety checks (bounds, overflow, union tags, `unreachable`) are on in Debug and ReleaseSafe and gone in ReleaseFast and ReleaseSmall.

## Taste

TigerBeetle's [TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) (Apache-2.0) is the taste reference Luiz admires. Its rules that carry into ordinary Zig:

- **Assertions in production code.** "The assertion density of the code must average a minimum of two assertions per function." Assert arguments, return values, pre- and postconditions, and invariants with `std.debug.assert`; pair them (assert a property where it is written and again where it is read). Assert relationships between constants at comptime (`comptime { assert(block_size % sector_size == 0); }`).
- **Bounds on everything.** Loops, queues and buffers have a stated maximum as a named constant. Prefer allocating at startup (or per request into an arena) over allocating in a hot loop.
- **Simple control flow.** No recursion in new code; an explicit stack with a bound instead.
- **Explicitly sized integers** (`u32`, `u64`) for stored and wire data; `usize` for indexes and lengths into memory.
- **Short functions.** TIGER_STYLE sets a hard limit of 70 lines. Split when a function passes it.
- **Units and qualifiers last** in names, most significant first: `latency_ms_max`, not `max_latency_ms`.
- **Lines at most 100 columns** (also the langref's guideline).

**Data shape first** (the `principles` skill: model-the-domain, type-system-discipline, boundary-discipline): parse external bytes into typed structs at the edge (`std.json.parseFromSlice` into a struct, a hand parser returning an error set) and pass those inward. A tagged `union(enum)` per state machine, `switch`ed exhaustively with no `else` prong on your own enums. Distinct types for distinct units (`enum(u64) { _ }` as a non-exhaustive newtype for IDs).

**Errors.** Name error sets per module (`const ParseError = error{ UnexpectedEof, InvalidTag };`) on public functions, so callers see what can fail; inferred `!T` is fine for private helpers. `errdefer` cleans up partial state. Error return traces are on by default only in Debug.

**comptime.** Use it for generics (`fn Queue(comptime T: type, comptime capacity: u32) type`, TitleCase because it returns a type), comptime assertions, and `@compileError` for unsupported configurations. `anytype` only where the set of accepted types is open by design (writers, formatters); otherwise name the type.

**Modules and visibility.** `pub` only on the module's interface. A file with top-level fields is itself a struct and is named `TitleCase.zig`; a namespace file is `snake_case.zig`.

**Concurrency** (0.16): `io.async` for work that may run independently (it may also run inline), `io.concurrent` when it must run in parallel, `Io.Group` for a set of tasks, all cancelled with `defer`. `Io.Mutex` and friends replace `std.Thread.Mutex`. Every `async` has a `defer ... cancel(io)` next to it.

**Naming** (langref style guide): `camelCase` functions, `TitleCase` types and type-returning functions, `snake_case` variables, fields, constants and namespace files. Acronyms are words (`HttpClient`, `readJson`). No redundant prefixes (`json.JsonValue` is `json.Value`). `///` doc comments on public declarations, `//!` at the top of a file.

## Toolchain and gates

Always the latest stable Zig (Luiz's rule), found at <https://ziglang.org/download/index.json> (the newest key that is not `master`). Zig development lives on Codeberg (codeberg.org/ziglang/zig). Match ZLS to the Zig version (github.com/zigtools/zls releases).

| Gate | Command |
|---|---|
| format | `zig fmt --check .` (fix: `zig fmt .`) |
| lint | none official; `zig ast-check <file>` catches unused locals and shadowing without a full build, and the compiler's own errors are strict |
| build and test | `zig build test --summary all`; safety on: `-Doptimize=Debug` (default) or `ReleaseSafe` |
| fuzz | `zig build test --fuzz` |
| dependencies | `zig fetch --save <url>` writes `.url` and `.hash` into `build.zig.zon`; never hand-edit a hash |

`build.zig.zon`'s `.fingerprint` is generated once and never changed (changing it has "security and trust implications", per the template); `.name` is an enum literal (`.name = .my_pkg`); `.paths` lists what the package hash covers.

## Testing ladder in Zig

The `tdd` skill owns the method and the rungs; this maps them to tools.

| Rung | Tool |
|---|---|
| 0 static | the compiler, comptime assertions, `zig fmt`, `zig ast-check` |
| 1 example | `test "name" { ... }` blocks beside the code; `std.testing.expect`, `expectEqual`, `expectEqualSlices`, `expectEqualStrings`, `expectError`; `zig build test`, filter with `--test-filter` |
| 2 integration | tests in a separate module added with its own `b.addTest`, driving real files under a temp dir through `std.testing.io` |
| 3 golden | expected output in a file read with `@embedFile`, compared with `expectEqualStrings`; none standard beyond that |
| 4 property | a seeded loop: `var prng = std.Random.DefaultPrng.init(std.testing.random_seed); const r = prng.random();`, generating inputs through production constructors; log the seed on failure and replay with `zig build test -- --seed=N` |
| 5 model-based | the same seeded loop generating a command sequence, applied to the system and to a dumb model (an array, a hash map), compared after each step. None standard as a library |
| 6 fuzzing | `std.testing.fuzz(ctx, testOne, .{ .corpus = &.{ @embedFile("seed.bin") } })` with `fn testOne(ctx: void, smith: *std.testing.Smith) !void` (0.16 API); run with `zig build test --fuzz`, which serves a web UI and saves crash inputs. Young: check your platform works before relying on it |
| allocation failure | `std.testing.checkAllAllocationFailures` reruns a test failing each allocation in turn; proves the `errdefer` paths |
| 7 mutation | none standard |
| 8 simulation | none standard as a library. The TigerBeetle method: all I/O, time and randomness behind an interface (here `std.Io` and `std.Random`), a simulator implementation driven by one seed, faults injected by the simulator. See TigerBeetle's [VOPR docs](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md) |

**Seams and substitutes.** Zig's interfaces are a pointer plus a vtable, the shape of `std.mem.Allocator` and `std.Io`: take the interface as a parameter and the test passes a different implementation (`std.testing.allocator`, `std.testing.FailingAllocator`, `std.testing.io`, `Io.failing`). For your own seams, either the same ptr-plus-vtable struct or a `comptime T: type` parameter the test instantiates with a fake. Never branch on `@import("builtin").is_test` in production code to swap behavior; that is a test-only path the real program never runs.

## Gotchas

- `std.Io.Writer` buffers; output is lost without `try w.flush()`.
- `{}` on a type with a `format` method is a compile error since 0.15; use `{f}` (or `{any}` to skip it).
- `std.ArrayList(T)` is unmanaged: `var list: std.ArrayList(T) = .empty;` and pass the allocator to every call (`list.append(gpa, x)`, `list.deinit(gpa)`).
- `GeneralPurposeAllocator` is now `std.heap.DebugAllocator`; in 0.16 `main` receives `init: std.process.Init` with `init.gpa`, `init.io` and `init.arena` already set up.
- `std.fs.File`/`std.fs.Dir` became `std.Io.File`/`std.Io.Dir`, and their methods take `io`.
- `@Type` is gone in 0.16 (`@Int`, `@Struct`, `@Enum`, … replace it); `usingnamespace`, `async` and `await` are gone since 0.15.
- Returning the address of a local is a compile error in 0.16; code that did it before was already a bug.

## Topics

- [references/zig-0.16.md](references/zig-0.16.md): before/after snippets for the 0.15 and 0.16 breaking changes, and a `build.zig` skeleton.
- [references/sources.md](references/sources.md): version targets, sources, open questions.
