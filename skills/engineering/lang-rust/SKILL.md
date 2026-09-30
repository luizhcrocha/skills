---
name: lang-rust
description: Rust rules and taste for tstack: non-negotiables, error and module style, the fmt/clippy/test gates, and the testing ladder's Rust tools. Use when writing, reviewing or testing Rust code.
paths: ["**/*.rs", "**/Cargo.toml"]
---

# Rust

## Version target

Rust 1.98.1 (stable since 2026-09-03), edition 2024, resolver 3, checked 2026-09-30. A project's pinned version wins: read `rust-toolchain.toml`, then `edition` and `rust-version` in `Cargo.toml` (or `[workspace.package]`) before writing code, and write only what that toolchain and edition accept. Most of Luiz's crates are still edition 2021 with `rust-version = "1.85"`; new crates start on 2024. Versions of every tool below are in [references/sources.md](references/sources.md).

## Non-negotiables

- **The gates pass before a change is done:** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (add `--workspace` in a workspace), and the tests. A repo with a `just check` recipe runs that instead; it is the same three steps.
- **No panics on input the program does not control.** `unwrap()`, `expect()`, indexing and `panic!` in non-test code are for invariants the code itself established. Each `expect("...")` message states that invariant. Anything that can fail at runtime (I/O, parsing, a missing key, a child process) returns `Result` and is propagated with `?`.
- **Every `unsafe` block has a `// SAFETY:` comment** directly above it naming the invariant that makes it sound. `unsafe` stays inside a small module with a safe interface; callers never see it.
- **A lint is silenced at the narrowest scope, with a reason:** `#[expect(clippy::lint_name, reason = "...")]` on the item. `expect` over `allow`, because it warns when the lint no longer fires and the suppression can go. No crate-level `#![allow]` for convenience.
- **Error context on every `?` that crosses an I/O or process boundary:** `.with_context(|| format!("reading {}", path.display()))`. A bare `?` on `fs::read` yields "No such file or directory" with no path.
- **Secrets stay out of `Debug`, `Display`, errors, logs and panic messages.** A type holding a token implements `Debug` by hand and redacts it.
- **Dependencies are explicit.** Clock, randomness, filesystem, network and child processes that decide an outcome come in through a trait or a parameter, not a global. See Seams below.

## Taste

**Data shape first** (the `principles` skill: model-the-domain, type-system-discipline, boundary-discipline):

- Parse at the edge into domain types, then pass the parsed type inward. `serde` derives on DTOs at the boundary; the core takes types whose constructors enforce the invariant (a newtype with a private field and a `TryFrom`/`parse` constructor).
- An `enum` per state machine, matched exhaustively. No wildcard `_ =>` arm on your own enums, so a new variant breaks every `match` that must handle it.
- Newtypes for IDs and units (`struct DurationMs(u64)`), not bare `u64`/`String` that can be swapped at a call site.
- Discrete named parameters over an options struct (Luiz's house rule in chimr's CLAUDE.md). When clippy's `too_many_arguments` fires, keep the parameters and write `#[expect(clippy::too_many_arguments, reason = "discrete named params, house style")]`. Group parameters into a struct only when the group is a domain concept with its own name.
- Keep the core pure: a function from state and input to a decision (midicaster's engine derives `ActionPlan`s; a daemon owns the clock and the I/O and runs them). The pure part is where tests and properties go.

**Errors.** Luiz's repos use `anyhow` throughout, libraries included, with `.context()` on every boundary call (chimr has ~950 of them). Follow that in those repos. For a new library crate whose callers must branch on the failure, return a `thiserror` enum from its public functions and keep `anyhow` in binaries and glue. `anyhow::bail!`/`ensure!` for early returns; `main` returns `anyhow::Result<()>`.

**Modules and visibility.** `pub(crate)` by default; `pub` only on the crate's interface. File modules (`foo.rs` + `foo/`) over `mod.rs` for new code. A workspace splits crates along real seams (chimr's `chimr-core` holds the logic surfaces link; the pure `midicaster-engine` has no I/O deps so it also builds for wasm). Shared versions live in `[workspace.dependencies]` and members write `dep = { workspace = true }`.

**Concurrency.** tokio for async I/O. Every spawned task has an owner that joins or aborts it; no fire-and-forget `tokio::spawn` without a handle kept or a comment naming who stops it. No `std::sync::Mutex` guard held across `.await`. Blocking work goes to `spawn_blocking` or a thread. Prefer message passing (`mpsc`, `watch`) over `Arc<Mutex<_>>` shared state.

**Resources.** RAII: a type that owns a child process, temp dir or lock releases it in `Drop`. Kill-on-drop for spawned children (`tokio::process::Command::kill_on_drop(true)`). Temporary files through `tempfile`.

**Naming** follows the Rust API Guidelines: `as_` (cheap borrow), `to_` (expensive conversion), `into_` (consumes self); getters without `get_`; `new` and `with_*` constructors; `snake_case` items, `UpperCamelCase` types, `SCREAMING_SNAKE_CASE` consts. Units in names when the type does not carry them (`timeout_ms`).

**Assertions.** `assert!` preconditions and invariants in production code where a violation means a bug, especially at state transitions (TigerBeetle's habit, see the `tdd` skill's ladder). `debug_assert!` only when the check is measurably expensive. Under a property test or a simulation, an assertion turns silent corruption into a failure at the point of fault.

## Toolchain and gates

Always the latest stable release of each tool (Luiz's rule). Find it with `cargo search <crate> --limit 1` or `https://crates.io/api/v1/crates/<crate>` for cargo subcommands, `rustup check` or <https://releases.rs> for Rust itself. In Luiz's repos the flake takes Rust from oxalica's `rust-overlay` as `rust-bin.stable.latest.default`.

| Gate | Command |
|---|---|
| format | `cargo fmt --check` (fix: `cargo fmt`) |
| lint | `cargo clippy --workspace --all-targets -- -D warnings` (fix: `cargo clippy --fix --allow-dirty --allow-staged --all-targets`) |
| tests | `cargo nextest run --workspace`, plus `cargo test --doc` when the crate has doctests (nextest does not run them) |
| manifest hygiene | `cargo sort --workspace --check`, `cargo machete` (unused deps) |
| docs | `cargo doc --no-deps --workspace` in CI |
| supply chain | `cargo deny check` where the repo has a `deny.toml` |

Luiz's repos run compiling steps through `mbx` (jdx/mr-boxington, a content-addressed rustc cache): `mbx clippy …`, `mbx nextest run …`, `mbx test`. Use `mbx` where the justfile does; `cargo fmt`, `cargo sort` and `cargo machete` stay on plain cargo. Clippy strictness is the default groups plus `-D warnings`; a crate that opts into `clippy::pedantic` does it in `[lints.clippy]` in `Cargo.toml` (or `[workspace.lints]` with `lints.workspace = true`), never through command-line flags.

## Testing ladder in Rust

The `tdd` skill owns the method and the rungs; this maps them to tools.

| Rung | Tool |
|---|---|
| 0 static | the type system, `clippy -D warnings`, `#[must_use]`, `#![forbid(unsafe_code)]` on crates with no `unsafe` |
| 1 example | `#[test]` in a `#[cfg(test)] mod tests` beside the code; `cargo nextest run` |
| 2 integration | `tests/*.rs` against the crate's public API, real filesystem via `tempfile`, real child processes; `#[ignore = "why"]` on tests needing hardware or credentials, run with `--run-ignored` |
| 3 golden | `insta` (`assert_snapshot!`, `assert_debug_snapshot!`, `assert_json_snapshot!`, redactions behind the `redactions` feature); review with `cargo insta review` and commit the `.snap` files; with `CI` set insta never writes snapshots. A labelled corpus with a baseline file is the same rung (chimr-polish's corpus ratchet, ADR-0022) |
| 4 property | `proptest` (`proptest!`, `prop_assert!`, strategies built from production constructors); commit `proptest-regressions/` |
| 5 model-based | `proptest-state-machine` (a reference state machine and the system under test driven by the same generated transitions) |
| 6 fuzzing | `cargo fuzz` (libFuzzer, nightly toolchain only for the fuzz run) with `arbitrary` for structured input; the corpus under `fuzz/corpus/` |
| 7 mutation | `cargo mutants`, usually `--in-diff` on a change or `-p <crate>` on a critical crate |
| 8 simulation | concurrency interleavings: `loom` (exhaustive over small models, `RUSTFLAGS="--cfg loom" cargo test --release`, slow-moving) or `shuttle` (randomized schedules, scales further, replays a failing schedule); hosts, network faults and time in one thread: `turmoil` over tokio (active; prefer it); a whole-runtime replacement: `madsim` (least active, pick only with a reason). Time alone: `#[tokio::test(start_paused = true)]` (needs tokio's `test-util`; freezes tokio's `Instant`, not `std::time::Instant`) |

Also: `cargo +nightly miri test` over any crate with `unsafe`.

**Seams and substitutes.** A trait at the boundary with a real and a fake implementation, passed in by the caller: hyprgate's `ProcReader` (`RealProc` / `FakeProc`), chimr's `Reporter`, `StopOps` and `RefinementJobs`. Generic parameters (`fn run<R: ProcReader>(procs: &R)`) when the call site picks one implementation statically, `&dyn Trait` when it varies at runtime. The fake is hand-written, lives beside the trait (or in `#[cfg(test)]`), and records what the test asserts on. No `mockall` or other generated mocks for your own traits; they couple the test to call order. For a clock, pass `now: Instant`/`SystemTime` into the pure function, or a small `Clock` trait into the service.

## Gotchas

- `cargo nextest` skips doctests. A crate that grows doc examples needs `cargo test --doc` in its gate (chimr's and midicaster's CI say so).
- Stale incremental cache: when a correct fix seems to have no effect, run `cargo clean -p <crate>` before debugging further (aimgr, three times).
- Rustdoc intra-doc links from public docs to private items fail the doc lint; write the name in backticks instead (hyprgate).
- rustls 0.23 panics at the first TLS handshake when two crypto providers are linked (aws-lc-rs via aws-sdk, ring via ureq); call `CryptoProvider::install_default()` at the top of `main` (chimr).
- A nested `cargo` build from `build.rs` against a workspace member deadlocks on the target-dir lock; build such crates outside the workspace (`exclude`) with their own `target/` (chimr, a 6-hour CI hang).
- A `--no-default-features` build only sheds a feature when every path dependency is declared with `default-features = false` and features are forwarded explicitly (chimr's `onnx`).
- A dependency whose types cross a crate boundary (iced, tray-icon in chimr) is pinned once in `[workspace.dependencies]`; two versions do not type-check against each other.
- Profile overrides: `debug = "line-tables-only"` in `[profile.dev]` keeps panics readable at half the disk; hot compute crates can get `opt-level = 3` in dev through `[profile.dev.package.<name>]`.
- Edition 2024 changes: `unsafe extern` blocks, `unsafe` attributes (`#[unsafe(no_mangle)]`), `std::env::set_var` is `unsafe`, `if let` temporaries drop earlier, `gen` is reserved. Moving a crate from 2021 is `cargo fix --edition` and a review of the diff.

## Topics

- [references/sources.md](references/sources.md): version targets, sources, Luiz's repos read, open questions.
