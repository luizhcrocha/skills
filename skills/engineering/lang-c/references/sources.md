# Sources

What lang-c makes claims about, the version it targets, and where that was checked. `tstack:lang-refresh` reads this table; keep one row per item and update the version and date when a row is rechecked.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| C standard (C23) | language | ISO/IEC 9899:2024; C2y draft N3886 | 2026-09-30 | https://www.open-std.org/jtc1/sc22/wg14/www/projects |
| GCC | tool | 16.2 | 2026-09-30 | https://gcc.gnu.org/gcc-16/changes.html |
| GCC C status | doc | GCC 16 | 2026-09-30 | https://gcc.gnu.org/projects/c-status.html |
| Clang/LLVM | tool | 23.1.2 | 2026-09-30 | https://github.com/llvm/llvm-project/releases |
| Clang C status | doc | Clang 23 | 2026-09-30 | https://clang.llvm.org/c_status.html |
| clang-tidy | tool | 23.1.2 | 2026-09-30 | https://releases.llvm.org/23.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html |
| clang-format | tool | 23.1.2 | 2026-09-30 | https://releases.llvm.org/23.1.0/tools/clang/docs/ReleaseNotes.html |
| clangd | tool | 23.1.2 | 2026-09-30 | https://clangd.llvm.org/installation |
| Sanitizers (ASan, UBSan, TSan, MSan) | doc | Clang 23 | 2026-09-30 | https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html |
| OpenSSF Compiler Options Hardening Guide | doc | 2026-08-20 | 2026-09-30 | https://best.openssf.org/Compiler-Hardening-Guides/Compiler-Options-Hardening-Guide-for-C-and-C++.html |
| cppcheck | tool | 2.22.0 | 2026-09-30 | https://github.com/danmar/cppcheck/releases |
| CMake | tool | 4.4.3 | 2026-09-30 | https://cmake.org/cmake/help/latest/release/4.4.html |
| Meson | tool | 1.12.1 | 2026-09-30 | https://mesonbuild.com/Release-notes.html |
| Unity | library | 2.7.0 | 2026-09-30 | https://github.com/ThrowTheSwitch/Unity/releases |
| cmocka | library | 2.0.2 | 2026-09-30 | https://gitlab.com/cmocka/cmocka/-/tags |
| theft | library | 0.4.5 (dormant since 2020) | 2026-09-30 | https://github.com/silentbicycle/theft |
| libFuzzer | tool | LLVM 23 (maintenance mode) | 2026-09-30 | https://llvm.org/docs/LibFuzzer.html |
| AFL++ | tool | 5.03c | 2026-09-30 | https://github.com/AFLplusplus/AFLplusplus/releases |
| Mull | tool | 0.34.1 (LLVM 13 to 22) | 2026-09-30 | https://github.com/mull-project/mull/releases |
| QMK firmware | tool | breaking-changes cycle 2026-08-30 (no release tags); Luiz's fork at upstream master of 2026-06-01 (c53dd0fb); gnu11 | 2026-09-30 | https://github.com/qmk/qmk_firmware/tree/master/docs/ChangeLog |
| QMK C coding conventions | doc | qmk_firmware 2026-06-01 | 2026-09-30 | https://docs.qmk.fm/coding_conventions_c |
| QMK CLI | tool | 1.2.0 | 2026-09-30 | https://pypi.org/project/qmk/ |

Research method: Sonnet research agents on official sources (vendor status pages, release notes, GitHub releases API) on 2026-09-30; the Clang and Mull versions rechecked through `gh api`.

## Luiz's repos read

- `~/repos/luizhcrocha/qmk-keymap` (External QMK Userspace for the ZSA Voyager): layout, `rules.mk` feature pattern, `process_record_user` shape, the keymap's `.clang-format`, build and flash loop, `compile_commands.json` origin; memo notes for the keymap traps. All in [qmk.md](qmk.md).
- `~/repos/luizhcrocha/qmk_firmware`, only `docs/coding_conventions_c.md`, `docs/pr_checklist.md`, `docs/keymap.md`, `.clang-format`, `.editorconfig` and the `-std`/warning lines of `builddefs/common_rules.mk`.

No other C repos of Luiz's were found; the general rules come from the official sources above.

## Open questions

- The keymap's style is split: `.clang-format` says 2 spaces (Google, 80 columns) and `luizrocha.c` follows it, while Luiz's newer `features/` files use 4 spaces like QMK. Which should new files follow? The skill says "keep each file's style" until Luiz decides.
- Custom keycodes start at `SAFE_RANGE`; QMK's PR checklist now asks for `QK_USER`. Move, or keep?
- `luizrocha.c` is included into `keymap.c` as one translation unit. Deliberate (LTO, shared statics), or a leftover from the fork?
- Stale absolute paths in the keymap repo: `compile_commands.json` and the voyager `config.h` point at `~/Github/qmk-keymap` / `~/Github/qmk_firmware`; `.cache/clangd` is committed; `.gitmodules` names a `qmk_firmware` submodule that does not exist.
- Is the Moonlander keymap still maintained next to the Voyager one?
- Clang's support for `<stdckdint.h>` was not confirmed on its status page (GCC has it since 14); check before relying on it in a Clang-only build.
