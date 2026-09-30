# Hardening flags (C and C++)

From the OpenSSF [Compiler Options Hardening Guide for C and C++](https://best.openssf.org/Compiler-Hardening-Guides/Compiler-Options-Hardening-Guide-for-C-and-C++.html) (version of 2026-08-20). The minimum compiler version is in brackets where the guide gives one. A project that already sets these in its build keeps its own list; add the missing ones only when the project's toolchain supports them.

## Warnings (every build)

`-Wall -Wextra -Wformat -Wformat=2 -Wconversion -Wsign-conversion -Wimplicit-fallthrough -Wbidi-chars=any` (GCC 12) `-Wtrampolines` (GCC only), and these as errors even where blanket `-Werror` is off: `-Werror=format-security -Werror=implicit -Werror=incompatible-pointer-types -Werror=int-conversion`.

Blanket `-Werror` belongs in development and CI builds. The guide keeps it out of builds that end users or distributions compile, where a newer compiler's new warning would break them.

## Runtime hardening (release builds)

- `-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3` (GCC 12, Clang 9); needs `-O1` or higher.
- `-fstack-protector-strong -fstack-clash-protection`.
- `-fstrict-flex-arrays=3` (GCC 13, Clang 16): write flexible array members as `[]`, never `[0]` or `[1]`.
- `-fcf-protection=full` on x86-64; `-mbranch-protection=standard` on AArch64.
- `-ftrivial-auto-var-init=zero` (GCC 12, Clang 8), `-fzero-init-padding-bits=all` (GCC 15).
- `-fno-delete-null-pointer-checks -fno-strict-overflow -fno-strict-aliasing` when the code base cannot prove it avoids those UBs.
- C++ only: `-D_GLIBCXX_ASSERTIONS` (libstdc++) or `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST` (libc++).
- GCC 14 and later: `-fhardened` turns on most of the above in one flag.

## Linking

`-Wl,-z,noexecstack -Wl,-z,relro -Wl,-z,now -Wl,-z,nodlopen -Wl,--as-needed -Wl,--no-copy-dt-needed-entries`, plus `-fPIE -pie` for executables or `-fPIC -shared` for libraries.

## Not for firmware

Embedded targets (QMK on a Cortex-M4, AVR) have no loader, no ASLR and no libc fortify, and several flags above do not exist there. On firmware the gates are the project's own warning set, `-Werror`, and code review; do not add hosted-system flags to a QMK build.
