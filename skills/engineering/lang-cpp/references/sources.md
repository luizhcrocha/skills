# Sources

What lang-cpp makes claims about, the version it targets, and where that was checked. `tstack:lang-refresh` reads this table; keep one row per item and update the version and date when a row is rechecked.

| item | kind | version targeted | checked on | source URL |
|---|---|---|---|---|
| C++ standard (C++23) | language | ISO/IEC 14882:2024 | 2026-09-30 | https://isocpp.org/std/the-standard |
| C++26 | language | technically complete 2026-03-28, DIS ballot | 2026-09-30 | https://isocpp.org/std/status |
| GCC | tool | 16.2 | 2026-09-30 | https://gcc.gnu.org/gcc-16/changes.html |
| GCC C++ status | doc | GCC 16 | 2026-09-30 | https://gcc.gnu.org/projects/cxx-status.html |
| libstdc++ status | doc | GCC 16 | 2026-09-30 | https://gcc.gnu.org/onlinedocs/libstdc++/manual/status.html |
| Clang/LLVM | tool | 23.1.2 | 2026-09-30 | https://github.com/llvm/llvm-project/releases |
| Clang C++ status | doc | Clang 23 | 2026-09-30 | https://clang.llvm.org/cxx_status.html |
| libc++ hardening | doc | LLVM 23 | 2026-09-30 | https://libcxx.llvm.org/Hardening.html |
| MSVC STL | tool | Build Tools 14.51 | 2026-09-30 | https://github.com/microsoft/STL/wiki/Changelog |
| MSVC conformance | doc | 2026-09-04 | 2026-09-30 | https://learn.microsoft.com/en-us/cpp/overview/visual-cpp-language-conformance |
| C++ Core Guidelines | doc | release 0.8, 2026-06-14 | 2026-09-30 | https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines |
| microsoft/GSL | library | 5.0.1 | 2026-09-30 | https://github.com/microsoft/GSL/releases |
| clang-tidy | tool | 23.1.2 | 2026-09-30 | https://releases.llvm.org/23.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html |
| clang-format | tool | 23.1.2 | 2026-09-30 | https://releases.llvm.org/23.1.0/tools/clang/docs/ReleaseNotes.html |
| clangd | tool | 23.1.2 | 2026-09-30 | https://clangd.llvm.org/installation |
| OpenSSF Compiler Options Hardening Guide | doc | 2026-08-20 | 2026-09-30 | https://best.openssf.org/Compiler-Hardening-Guides/Compiler-Options-Hardening-Guide-for-C-and-C++.html |
| CMake | tool | 4.4.3 | 2026-09-30 | https://cmake.org/cmake/help/latest/release/4.4.html |
| Meson | tool | 1.12.1 | 2026-09-30 | https://mesonbuild.com/Release-notes.html |
| vcpkg | tool | 2026.07.29 | 2026-09-30 | https://github.com/microsoft/vcpkg/releases |
| Conan | tool | 2.33.0 | 2026-09-30 | https://github.com/conan-io/conan/releases |
| GoogleTest | library | 1.18.0 | 2026-09-30 | https://github.com/google/googletest/releases |
| Catch2 | library | 3.16.0 | 2026-09-30 | https://github.com/catchorg/Catch2/releases |
| doctest | library | 2.5.3 | 2026-09-30 | https://github.com/doctest/doctest/releases |
| rapidcheck | library | master of 2026-08-06 (no releases) | 2026-09-30 | https://github.com/emil-e/rapidcheck/commits/master |
| FuzzTest | library | 2026-06-29 | 2026-09-30 | https://github.com/google/fuzztest/releases |
| libFuzzer | tool | LLVM 23 (maintenance mode) | 2026-09-30 | https://llvm.org/docs/LibFuzzer.html |
| AFL++ | tool | 5.03c | 2026-09-30 | https://github.com/AFLplusplus/AFLplusplus/releases |
| Mull | tool | 0.34.1 (LLVM 13 to 22) | 2026-09-30 | https://github.com/mull-project/mull/releases |

Research method: a Sonnet research agent on official sources (WG21 and ISO pages, vendor status pages, the Core Guidelines' raw markdown, GitHub releases API) on 2026-09-30; the C++26 schedule is from Herb Sutter's trip report of 2026-03-29 (https://herbsutter.com/2026/03/29/c26-is-done-trip-report-march-2026-iso-c-standards-meeting-london-croydon-uk/), the convenor's own account.

## Luiz's repos read

None. Luiz has no C++ repositories, so this skill is research-only: every rule comes from the official sources above and the Core Guidelines, with nothing codified from his habits yet. The first C++ project he works on is where its Open questions get answered.

## Open questions

- Error strategy for new code: the skill defaults to `std::expected` for expected failures and exceptions for the rest. Luiz's TypeScript taste (typed failures) points that way; confirm on the first real project.
- The C++26 DIS ballot dates (registered 2026-06-02, ballot from 2026-07-31) came from a search summary: iso.org (ISO/IEC DIS 14882, https://www.iso.org/standard/91179.html) refuses scripted fetches, so the row points at isocpp.org's status page. The next refresh should confirm publication.
- libc++'s C++26 status (`inplace_vector`, `std::execution`, `linalg`) was read as "not started" from a possibly stale page; recheck before relying on those.
- Whether MSan requires an instrumented libc++ is from LLVM's general guidance, not the MSan page itself.
