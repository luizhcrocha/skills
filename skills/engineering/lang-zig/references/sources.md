# lang-zig sources

The refresher reads this table. "Checked on" is the date the version was looked up on the official page, never from memory.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| Zig (compiler, std) | language | 0.16.0 (2026-04-13); master is 0.17.0-dev | 2026-09-30 | https://ziglang.org/download/index.json, https://ziglang.org/download/0.16.0/release-notes.html |
| Zig 0.15 changes (Writergate, unmanaged ArrayList, `root_module`) | language | 0.15.1 notes (0.15.2 on 2025-10-11) | 2026-09-30 | https://ziglang.org/download/0.15.1/release-notes.html |
| Zig language reference (style guide, build modes, allocators) | doc | 0.16.0 | 2026-09-30 | https://ziglang.org/documentation/0.16.0/ |
| Zig build system guide | doc | 0.16.0 | 2026-09-30 | https://ziglang.org/learn/build-system/ |
| Zig source (std.testing, init templates, `ast-check`) | doc | tag 0.16.0 | 2026-09-30 | https://codeberg.org/ziglang/zig/src/tag/0.16.0 |
| std.testing.fuzz / `zig build test --fuzz` | tool | 0.16.0 (Smith API) | 2026-09-30 | https://ziglang.org/download/0.16.0/release-notes.html |
| ZLS | tool | 0.16.0 (2026-04-16) | 2026-09-30 | https://github.com/zigtools/zls/releases |
| TigerBeetle TIGER_STYLE.md | doc | main; repo license Apache-2.0 | 2026-09-30 | https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md |
| TigerBeetle VOPR (deterministic simulation) | doc | main | 2026-09-30 | https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md |

## Luiz's repos read

None. Luiz has no Zig repository as of 2026-09-30, so every rule here comes from the official Zig docs and release notes, plus TigerBeetle's TIGER_STYLE.md as the taste reference. No memo notes exist for Zig. When the first Zig repo appears, read it and move its conventions in, flagging anything that disagrees.

## Quoting TIGER_STYLE.md

TigerBeetle is Apache-2.0 (the repo's LICENSE file); TIGER_STYLE.md carries no separate license header. The skill quotes one sentence verbatim with a link and paraphrases the rest.

## Open questions

- **Fuzzing platform support.** The 0.16 release notes describe `zig build test --fuzz` (multi-process `-j`, infinite mode, saved crash inputs, web UI) but do not say which OS/arch pairs it supports. Test on the target machine before relying on it.
- **TigerBeetle's rules Luiz wants literally.** The skill adopts assertion density, bounds, no recursion, explicitly sized integers, 70-line functions, units-last naming and 100 columns. It leaves out "static allocation at startup only" and "zero dependencies" as defaults, since they suit a database more than a CLI. Confirm.
- **`usize` vs `u32`.** TIGER_STYLE says avoid `usize`; the std APIs take `usize` for lengths and indexes. The skill keeps `usize` for in-memory indexes and sized integers for stored and wire data.
- **No official linter or mutation tool.** `zig ast-check` is the nearest check; rung 7 has no standard tool.
- Unverified: the exact release that renamed `GeneralPurposeAllocator` to `DebugAllocator`, and the date Zig's development moved from GitHub to Codeberg.
