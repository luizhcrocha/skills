# lang-rust sources

The refresher reads this table. "Checked on" is the date the version was looked up in the registry or release page, never from memory.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| Rust (rustc, std) | language | 1.98.1 (2026-09-03); 1.99.0 due 2026-10-01 | 2026-09-30 | https://github.com/rust-lang/rust/blob/master/RELEASES.md |
| Rust edition | language | 2024 (stable since 1.85); no 2027 announcement | 2026-09-30 | https://doc.rust-lang.org/edition-guide/rust-2024/index.html |
| Cargo | tool | ships with 1.98.1 (resolver 3 since 1.84, `build.warnings` since 1.97) | 2026-09-30 | https://doc.rust-lang.org/cargo/CHANGELOG.html |
| Clippy | tool | ships with 1.98.1 | 2026-09-30 | https://github.com/rust-lang/rust-clippy/blob/master/CHANGELOG.md |
| rustfmt | tool | ships with 1.98.1; `style_edition` stable | 2026-09-30 | https://rust-lang.github.io/rustfmt/ |
| `#[expect]` with `reason` | language | stable since 1.81 | 2026-09-30 | https://github.com/rust-lang/rust/blob/master/RELEASES.md |
| rust-overlay (oxalica) | tool | `rust-bin.stable.latest` (tracks stable) | 2026-09-30 | https://github.com/oxalica/rust-overlay |
| mbx (jdx/mr-boxington) | tool | v1.21.0 (2026-09-29) | 2026-09-30 | https://github.com/jdx/mr-boxington/releases |
| cargo-nextest | tool | 0.9.146 | 2026-09-30 | https://crates.io/crates/cargo-nextest, https://nexte.st/docs/running/ |
| cargo-sort | tool | 2.1.4 | 2026-09-30 | https://crates.io/crates/cargo-sort |
| cargo-machete | tool | 0.9.2 | 2026-09-30 | https://crates.io/crates/cargo-machete |
| cargo-release | tool | 1.1.6 | 2026-09-30 | https://crates.io/crates/cargo-release |
| insta / cargo-insta | library / tool | 1.48.0 | 2026-09-30 | https://crates.io/crates/insta, https://insta.rs/docs/ |
| proptest | library | 1.11.0 | 2026-09-30 | https://crates.io/crates/proptest, https://proptest-rs.github.io/proptest/proptest/failure-persistence.html |
| proptest-state-machine | library | 0.8.0 | 2026-09-30 | https://crates.io/crates/proptest-state-machine |
| bolero | library | 0.13.6 (alternative front end for fuzz + property) | 2026-09-30 | https://crates.io/crates/bolero |
| cargo-fuzz | tool | 0.13.2 (needs nightly) | 2026-09-30 | https://crates.io/crates/cargo-fuzz, https://rust-fuzz.github.io/book/cargo-fuzz.html |
| libfuzzer-sys | library | 0.4.13 | 2026-09-30 | https://crates.io/crates/libfuzzer-sys |
| arbitrary | library | 1.4.2 | 2026-09-30 | https://crates.io/crates/arbitrary |
| cargo-mutants | tool | 27.1.0 | 2026-09-30 | https://crates.io/crates/cargo-mutants, https://mutants.rs/in-diff.html |
| mutants (attribute) | library | 0.0.4 | 2026-09-30 | https://crates.io/crates/mutants |
| loom | library | 0.7.2 (last crates.io release 2024-04-23) | 2026-09-30 | https://crates.io/crates/loom |
| shuttle | library | 0.9.4 (2026-09-22) | 2026-09-30 | https://crates.io/crates/shuttle |
| turmoil | library | 0.7.2 (2026-04-24) | 2026-09-30 | https://crates.io/crates/turmoil |
| madsim | library | 0.2.34 (2025-10-11) | 2026-09-30 | https://crates.io/crates/madsim |
| tokio | library | 1.53.1 | 2026-09-30 | https://crates.io/crates/tokio, https://docs.rs/tokio/latest/tokio/time/fn.pause.html |
| anyhow | library | 1.0.104 | 2026-09-30 | https://crates.io/crates/anyhow |
| thiserror | library | 2.0.21 | 2026-09-30 | https://crates.io/crates/thiserror |
| mockall | library | 0.15.0 (named only to rule it out for own traits) | 2026-09-30 | https://crates.io/crates/mockall |
| Miri | tool | nightly rustup component | 2026-09-30 | https://github.com/rust-lang/miri |
| cargo-deny | tool | 0.20.2 | 2026-09-30 | https://crates.io/crates/cargo-deny |
| Rust API Guidelines | doc | unversioned | 2026-09-30 | https://rust-lang.github.io/api-guidelines/naming.html |
| TigerBeetle TIGER_STYLE.md | doc | main (Apache-2.0) | 2026-09-30 | https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md |

## Luiz's repos read

Read on 2026-09-30, read-only.

- `~/repos/coelhorocha/chimr` (hybrid workspace, 18 members, edition 2021, `rust-version = "1.85"`): the gate (`tasks/check`: `cargo fmt --check`, `mbx clippy --workspace --all-targets -- -D warnings`, `mbx nextest run --workspace`; CI adds `cargo sort`, `cargo machete`, `mbx doc --no-deps`), `anyhow` everywhere with ~950 `.context()` calls and no `thiserror`, `[workspace.dependencies]` for types that cross crates (iced, tray-icon), trait seams with real and hand-written fakes (`Reporter`, `StopOps`, `RefinementJobs`), `#[cfg(test)] mod tests` in 190 files plus `tests/` dirs, `#[ignore = "reason"]` for hardware tests, the labelled corpus ratchet (ADR-0022), ADR-0014 (the pipeline is a crate; divergence is a value), dev-profile tuning, nested-cargo deadlock and `default-features = false` gotchas. CLAUDE.md: discrete positional params, never an options object. memo: `too_many_arguments` suppression with a rationale, rustls `CryptoProvider::install_default()`.
- `~/repos/luizhcrocha/aimgr` (single crate, 2021, 1.85): the `just check` recipe (`cargo fmt --check`, `mbx clippy --all-targets -- -D warnings`, `mbx test`), `just fix` (`mbx clippy --fix`, `cargo sort --workspace`, `cargo fmt`), Rust from `rust-overlay` `stable.latest` in `flake.nix`, `mbx` packaged in the flake. memo: stale incremental cache, `cargo clean -p`.
- `~/repos/luizhcrocha/hyprgate` (single crate, 2021, 1.85, tokio): same justfile; trait seams `ProcReader` (`RealProc`/`FakeProc`), `GateFs`, `Detector`; `tests/recipes_e2e.rs`. memo: rustdoc intra-doc links to private items.
- `~/repos/luizhcrocha/ocrgrab` (single crate, 2021, 1.89, tokio): same justfile plus a smoke recipe in a throwaway HOME; `tests/` integration files; trait seam `PatternRecognizer`.
- `~/repos/coelhorocha/midicaster` (workspace, edition 2024, resolver 2): pure `midicaster-engine` crate with no I/O deps (also builds to wasm), daemon owns the clock and I/O; CI runs plain `cargo clippy --locked --workspace --all-targets -- -D warnings` and `cargo nextest run --locked --workspace --all-targets`; tools pinned in `mise.toml`.

## Open questions

- **`anyhow` in library crates.** Every repo uses `anyhow` in libraries too (chimr-core, chimr-pipeline, midicaster-engine); no crate defines an error enum. The skill follows that and recommends `thiserror` only for a new library whose callers branch on the failure. Decided (Luiz, 2026-09-30): that is the line; anyhow stays, thiserror only for a library whose callers branch on the failure.
- **`#[allow]` vs `#[expect(..., reason)]`.** chimr uses `#[allow(clippy::too_many_arguments)]` with a trailing comment (and the memo note says so); the skill asks for `#[expect(..., reason = "...")]` (stable since 1.81), which does the same and warns when stale. Adopt repo-wide?
- **No `[lints]` tables anywhere.** Strictness lives only in `-D warnings` on the command line. Should repos declare `[workspace.lints]` (for example `unsafe_code`, `undocumented_unsafe_blocks`, `dbg_macro`) so editors and CI agree? Rust 1.97 also stabilized `build.warnings`, which clippy's README now prefers over `-D warnings`.
- **Editions and MSRV differ:** chimr, aimgr, hyprgate on 2021/1.85, ocrgrab 2021/1.89, midicaster 2024 with `resolver = "2"` (edition 2024 implies 3 for a package, but a workspace sets it explicitly). Move the 2021 crates to 2024?
- **Runner differs:** chimr and midicaster use nextest; aimgr, hyprgate and ocrgrab use `mbx test`. midicaster calls plain `cargo`, the rest `mbx`.
- **`mbx` pinned at 1.8.0** in aimgr, hyprgate, ocrgrab and chimr's second pin, while the latest is v1.21.0 (2026-09-29). Luiz's rule says latest; the flakes need a bump.
- **unwrap in non-test code:** chimr-polish and chimr-core have many `unwrap()` calls; many are inside `#[cfg(test)]` modules in the same files, and the rest were not audited. A `clippy::unwrap_used` lint with `allow-unwrap-in-tests` would settle it.
- Upstream items not verified from docs: the stabilization status of cargo script, loom's crates.io vs GitHub release-date mismatch.
