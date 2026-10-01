# lang-swift sources

The refresher reads this table. "Checked on" is the date the version was looked up on the official page or registry API, never from memory.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| Swift (compiler, stdlib) | language | 6.4.0 (2026-09-15); 6.3.3 was the last 6.3 | 2026-10-01 | https://api.github.com/repos/swiftlang/swift/releases, https://raw.githubusercontent.com/swiftlang/swift/swift-6.4.0-RELEASE/CHANGELOG.md |
| Swift evolution (SE-0528 noncopyable `Continuation`, SE-0510 `mapKeyedValues`) | doc | SE-0528 implemented in 6.4; SE-0510 accepted with modifications | 2026-10-01 | https://github.com/swiftlang/swift-evolution/tree/main/proposals |
| Xcode | tool | 27 (2026-09-15; Swift 6.4, iOS 27 and macOS 27 SDKs; needs macOS Tahoe 26.6); 27.1 in beta | 2026-10-01 | https://developer.apple.com/documentation/xcode-release-notes (secondary: https://mjtsai.com/blog/2026/09/15/xcode-27/) |
| swiftly | tool | 1.2.0 (2026-09-22) | 2026-10-01 | https://github.com/swiftlang/swiftly/releases |
| swift-format (`swift format`, in the toolchain) | tool | 604.0.0 (2026-09-16) | 2026-10-01 | https://github.com/swiftlang/swift-format/releases |
| SwiftLint | tool | 0.65.1 (2026-08-21); Linux binaries and `ghcr.io/realm/swiftlint` | 2026-10-01 | https://github.com/realm/SwiftLint/releases |
| Swift Testing (exit tests, ST-0008) | library | ships with the toolchain; exit tests since 6.2 | 2026-10-01 | https://github.com/swiftlang/swift-evolution/blob/main/proposals/testing/0008-exit-tests.md |
| swift-snapshot-testing | library | 1.19.6 (2026-09-21), Swift Testing trait | 2026-10-01 | https://github.com/pointfreeco/swift-snapshot-testing/releases |
| swift-property-based (`PropertyBased`) | library | 2.0.1 (2026-09-25), needs Swift 6.2 | 2026-10-01 | https://github.com/x-sheep/swift-property-based |
| SwiftCheck | library | 0.12.0 (2019-03-28), unmaintained; do not use | 2026-10-01 | https://github.com/typelift/SwiftCheck |
| libFuzzer integration (`-sanitize=fuzzer`) | doc | main | 2026-10-01 | https://github.com/swiftlang/swift/blob/main/docs/libFuzzerIntegration.md |
| Muter | tool | release "16" (2023-09-16); repo active, no release since | 2026-10-01 | https://github.com/muter-mutation-testing/muter |
| Swift API Design Guidelines | doc | current | 2026-10-01 | https://www.swift.org/documentation/api-design-guidelines/ |

`references/modern-swift.md` syncs from the upstream recorded in `upstreams.toml` (the write-swift mapping). It was written against Swift 6.3; its version notes were moved to 6.4 here, so a sync that touches them is a conflict to resolve by intent.

## Luiz's repos read

None with Swift as a language of the project. The only Swift file is a spike, `chimr/spikes/mac-voice-processing/vpcap.swift`, built with `swiftc -O` and no package; nothing to codify from it. No memo notes mention Swift. When the first Swift repo appears, read it and move its conventions in, flagging anything that disagrees.

## Open questions

- **Swift on Linux through Nix.** nixpkgs carries Swift 5.10.1 and swift-format 5.10.1 (stale); `swiftlint` is 0.65.1. Luiz's rule says to take a stale tool from upstream, so the skill names swiftly. A devenv or flake recipe for the 6.4 toolchain is still to write.
- **`swiftly install` arguments.** The README shows only `swiftly install main-snapshot`; the skill names swiftly without a subcommand until `swiftly --help` is checked on a machine.
- **Fuzzing platforms.** The libFuzzer doc does not say which toolchains link libFuzzer (Linux, the swift.org macOS toolchain, Xcode's). Test on the target before relying on rung 6.
- **Muter on Linux.** Its badge says macOS and Linux, its text says macOS 10.15 or later only. Treated as macOS only.
- **6.4 items not in the compiler changelog.** `mapKeyedValues` (SE-0510 says only "Accepted with modifications"), the noncopyable `Continuation` (SE-0528 says "Implemented (Swift 6.4)") and `weak let` are standard library or unlisted changes. The reference keeps them under ⚠; confirm on a 6.4 toolchain before relying on one.
- **Xcode 27 project defaults.** Xcode 26 made approachable concurrency and main-actor isolation the default for new app projects; the Xcode 27 release notes did not load, so 27's defaults are unchecked.
- **No Swift lint pack.** `lint/` has no `swift` pack and `lint/registry.toml` no Swift rule: D12 starts a rule from a repeated lesson in a real repo, and there is none yet.
