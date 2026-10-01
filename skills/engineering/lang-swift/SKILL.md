---
name: lang-swift
description: "Swift rules and taste for tstack: Swift 6.4, value types first, the 6.2 concurrency model, swift-format and SwiftLint gates, Swift Testing and the ladder. Use when writing, reviewing or testing Swift code."
paths: ["**/*.swift", "**/Package.swift"]
---

# Swift

## Version target

Swift 6.4.0 (released 2026-09-15) and Xcode 27 (Swift 6.4, the iOS 27 and macOS 27 SDKs; needs macOS Tahoe 26.6), checked 2026-10-01. A project's pinned version wins: read `// swift-tools-version:` in `Package.swift`, a `.swift-version` file, and `SWIFT_VERSION` in the Xcode project first, and write only what that toolchain accepts. A new package writes `// swift-tools-version: 6.4` when it can require the 6.4 toolchain, else 6.2, the first with `.defaultIsolation(MainActor.self)`. Written from official docs only; Luiz has no Swift repo yet ([references/sources.md](references/sources.md)).

Training data mostly predates Swift 6.2, which changed what `async` means. Before writing concurrency code, read §3 to §6 of [references/modern-swift.md](references/modern-swift.md).

## Non-negotiables

- **Swift 6 language mode, complete data-race checking.** Tools version 6.0 or later turns it on for a package. Never lower it to admit new code.
- **Data races are fixed, not silenced.** `@unchecked Sendable` only on a type with real internal synchronization (a `Mutex`, a lock), and `nonisolated(unsafe)` only as a last resort, each with a comment naming what keeps it safe.
- **Recoverable failures `throw`; programmer mistakes halt** with `precondition` or `fatalError` and a message. A force unwrap states the invariant that makes it safe, or becomes `guard` or `try #require`.
- **Single-threaded first.** Code stays on the main actor until Instruments shows a hang. Then `async`, then `@concurrent`, then an `actor`, in that order.
- **Libraries are `nonisolated`.** Default main-actor isolation is for app and UI modules, never for a general-purpose library.
- **The gates pass:** `swift format lint --strict -r .`, `swiftlint lint --strict` where the repo has a `.swiftlint.yml`, and `swift build` and `swift test` with no warnings.

## Taste

Swift buys dynamism only with a reason you can state. The hierarchy of defaults, from the top of the reference:

| Need | Reach for | Move down only when |
| --- | --- | --- |
| Data | `struct`, `enum` | you need identity, sharing or inheritance |
| Abstraction | a concrete type | code repeats across types |
| Polymorphism | `some P` | you store mixed types (`any P`) |
| Execution | main actor, synchronous | profiling shows a hang |
| Memory | `Array`, `String` | profiling shows the cost (`InlineArray`, `Span`) |
| Safety | the safe API | C interop or a measured hot path (`Unsafe*`) |

- **Data shape first** (the `principles` skill: model the domain, type-system discipline, boundary discipline). Parse external bytes into value types at the edge (`Codable` into a struct). One `enum` with associated values per set of exclusive states, never a group of optional properties. A typed ID (`struct OrderID { let raw: UUID }`) over a bare `String`.
- **Errors.** Enums with associated values carry the context. Untyped `throws` on public API keeps the freedom to change the error; typed `throws(E)` for internal and error-forwarding generic code.
- **Protocols come last.** Write concrete types, notice the repetition, then extract a protocol with real per-type customization. A requirement is a customization point; a method only in an extension is not.
- **Concurrency.** Structured first: `async let` for a fixed count, `withTaskGroup` (bounded) for a dynamic one, `Task { }` only for work tied to an event. Mutate actor state in synchronous methods; re-check state after every `await`.
- **Modules and visibility.** Access control is the documented interface: `public` and `package` only where callers need them; public types state `Sendable` by hand.
- **Naming.** Clarity at the point of use (the API Design Guidelines): no type prefixes in Swift-only code, no `get` on accessors, argument labels that read as a phrase.

## Toolchain and gates

Always the latest stable release (Luiz's rule): the newest `swift-X.Y.Z-RELEASE` in `api.github.com/repos/swiftlang/swift/releases`. On Linux install it through swiftly (swift.org/install), not nixpkgs, whose newest Swift is 5.10.1. On macOS the latest Xcode carries it.

| Gate | Command |
| --- | --- |
| format | `swift format lint --strict -r .` (fix: `swift format -i -r .`); config in `.swift-format`, defaults from `swift format dump-configuration` |
| lint | `swiftlint lint --strict` with the repo's `.swiftlint.yml`; on Linux it needs SourceKit (`LINUX_SOURCEKIT_LIB_PATH`) |
| build | `swift build -Xswiftc -warnings-as-errors` |
| test | `swift test` |

swift-format ships inside the toolchain (`swift format`), so it needs no install. SwiftLint is optional: add it to a repo only with its own `.swiftlint.yml`.

## Testing ladder in Swift

The `tdd` skill owns the method and the rungs; this maps them to tools.

| Rung | Tool |
| --- | --- |
| 0 static | the compiler in Swift 6 mode, swift-format, SwiftLint |
| 1 example | Swift Testing: `@Test`, `#expect`, `try #require`, suites as structs; `swift test --filter` |
| 2 integration | a separate test target driving real files in a temporary directory and real local services |
| 3 golden | swift-snapshot-testing (pointfreeco), with its Swift Testing trait `@Suite(.snapshots(record: .failed))` |
| 4 property | `@Test(arguments:)` for chosen cases; generated cases with shrinking through x-sheep's swift-property-based (`PropertyBased`, Swift 6.2 or later). SwiftCheck is unmaintained since 2019 |
| 5 model-based | a seeded generator producing a command sequence, applied to the system and to a plain model, compared after each step; none standard as a library |
| 6 fuzzing | libFuzzer: `swiftc -sanitize=fuzzer,address -parse-as-library` with an `@_cdecl("LLVMFuzzerTestOneInput")` entry point; check the platform's toolchain first |
| exit paths | exit tests, `#expect(processExitsWith: .failure) { ... }` (Swift 6.2; macOS, Linux, Windows, not iOS) |
| 7 mutation | Muter, macOS only in practice, last release 2023; treat as unproven |
| 8 simulation | none standard; time, randomness and I/O behind protocols with a seeded simulator implementation |

**Seams and substitutes.** A protocol with the production type and a hand-written fake, injected through the initializer, or a struct of closures for a small seam. No mocking framework for our own modules. Never branch on a test flag in production code.

## Gotchas

- `async` no longer leaves the caller's actor (Swift 6.2). Code that relied on it to get off the main thread now blocks it; mark the work `@concurrent`.
- Actors are reentrant and not FIFO: between two `await`s other work runs, and a check-download-write cache races.
- A `weak` reference read after the owner's last use may be `nil`. An object's lifetime ends at its last use, not at the closing brace.
- `[any P]` and `any P` arguments cost boxing and block specialization; `[MyModel]` and `some P` do not.
- `Array.remove(at:)` in a loop is O(n²); use `removeAll(where:)`.
- Rows marked ⚠ in the reference need Swift 6.4; a project on 6.3 uses the older form.

## Topics

- [references/modern-swift.md](references/modern-swift.md): the full guide, by section: 1 value types, 2 errors, 3 to 6 concurrency (the 6.2 model, `Sendable`, structured concurrency, SwiftUI), 7 protocols and generics, 8 API design, 9 performance, 10 ARC, 11 Swift Testing, 12 macros, 13 logging, 14 unsafe code and interop, 15 modern syntax by version, 16 migrating to Swift 6, and a quick-reference table.
- [references/sources.md](references/sources.md): version targets, sources, open questions.
