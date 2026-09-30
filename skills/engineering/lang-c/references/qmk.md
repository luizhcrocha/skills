# QMK firmware and Luiz's keymap

Luiz's C is keyboard firmware: `~/repos/luizhcrocha/qmk-keymap`, an External QMK Userspace (`qmk.json`, `userspace_version` 1.1, one build target `zsa/voyager:luizrocha`), forked from Pascal Getreuer's keymap. The firmware tree is `~/repos/luizhcrocha/qmk_firmware` (Luiz's fork of qmk/qmk_firmware, remote `upstream`). `qmk config` points `user.overlay_dir` at the keymap repo and `user.qmk_home` at the firmware.

## What differs from general C here

- **C11, not C23.** QMK builds with `-std=gnu11` (`builddefs/common_rules.mk`) and `arm-none-eabi-gcc` (15.2 on this machine; the Voyager is a Cortex-M4, `-Os`, LTO). No `constexpr`, `nullptr`, `[[nodiscard]]`, `<stdckdint.h>` or `= {}`.
- **Warnings fail the build.** QMK adds `-Wall -Werror` (unless `ALLOW_WARNINGS=yes`) and `-Wstrict-prototypes`, so an empty parameter list is `void f(void)`.
- **No heap, no libc I/O.** State is `static` at file scope, tables are `const ... PROGMEM` arrays, sizes are compile-time constants. The hosted-system rules (sanitizers, hardening flags, fuzzing) do not apply to firmware.
- **QMK's APIs, not the hardware.** `wait_ms()` rather than `_delay_ms()`, `timer_read()`/`timer_read32()` and `timer_elapsed()`, never raw GPIO/I2C/SPI.
- **Callbacks are the interface.** `process_record_user` returns `false` when it handled a key and `true` to let QMK continue; `post_process_record_user`, `housekeeping_task_user` and the `get_*_per_key` callbacks are the other hooks. Feature hooks are called under `#ifdef X_ENABLE`.
- **Layers and custom keycodes are enums.** `enum layers { BASE, SYM, ... }`, `enum custom_keycodes { ARROW = SAFE_RANGE, ... }` (QMK's PR checklist now names `QK_USER` for user keycodes; the keymap uses `SAFE_RANGE`, which still works). Key aliases (`HRM_*`) are `#define`s.
- **Keymap tables** stay in `// clang-format off` / `// clang-format on` so the columns keep the physical layout.

## QMK's own conventions (docs/coding_conventions_c.md)

Match the surrounding code first. Then: 4-space indent, braces always (even one-line `if`s), `} else {` on one line, `#pragma once` rather than include guards, `#if defined(X)` preferred over `#ifdef X` in new code, lowercase file names, `/* */` or `//` comments that say why. These bind core and keyboard code sent upstream; a personal keymap is not accepted upstream, so for the keymap they are guidance. `qmk format-c` applies qmk_firmware's `.clang-format` (4 spaces, 1000 columns), not the keymap's.

## Luiz's keymap, as it is

- `luizrocha.c` (about 2,250 lines) holds the whole keymap. The per-board `keyboards/zsa/voyager/keymaps/luizrocha/keymap.c` includes it (`#include "luizrocha.c"`), so the keymap is one translation unit and its `static` helpers are visible everywhere.
- `features/*.c` are opt-in modules added in `rules.mk` (`X_ENABLE ?= yes`, `OPT_DEFS += -DX_ENABLE`, `SRC += features/x.c`). Luiz's own modules (`text_expander`, `typed_history`, `string_sender`, `layout_handler`, `os_handler`, `bios_helper`, `user_config`) expose a `const T *` getter rather than their buffer.
- Tuning lives in `config_luizrocha.h`, one `//` comment per define (TAPPING_TERM, FLOW_TAP_TERM, chordal hold, per-key callbacks).
- Style is mixed: the keymap's `.clang-format` is Google style, 2 spaces, 80 columns, and `luizrocha.c` follows it; Luiz's newer `features/` files use 4 spaces. Keep each file's own style and format with the keymap's `.clang-format` (`clang-format -style=file -i`), not `qmk format-c`.
- Commits follow Conventional Commits (`feat(combos): ...`).

## Build, flash, verify

- Build and flash: `qmk flash -kb zsa/voyager -km luizrocha`. `qmk compile` and `qmk flash` call `build_keyboard.mk` directly with `QMK_USERSPACE`, bypassing the userspace `Makefile`.
- Debug: `mise run qmk-console` flashes with `-e CONSOLE_ENABLE=yes` (rules.mk untouched) and opens `qmk console`; `mise run qmk-console --revert` flashes the normal build.
- There are no tests and no CI: verification is a clean compile (warnings fail it) and then Luiz flashing and typing. A change that must behave a certain way is described with the exact keys to press, for Luiz to try.
- clangd needs a fresh `compile_commands.json`: `qmk generate-compilation-database -kb zsa/voyager -km luizrocha`. The one in the repo is stale (its `directory` is `/home/luizrocha/Github/qmk_firmware`).

## Traps (from memo notes and the code)

- `MT(mod, kc)` and `LT(layer, kc)` keep only 8 bits of the tap keycode, so a `SAFE_RANGE` custom keycode is truncated (RGBHUP became KC_HOME). Put a basic keycode in the tap slot and intercept it in `process_record_user`.
- Same-hand combos resolve as taps because of Flow Tap (100 ms), not Chordal Hold; `get_chordal_hold` whitelists only A+S and A+F.
- The OS turns physical Caps Lock into Compose (fcitx5/XKB), so Caps never reaches the OS: `TD_CAPS` gives Caps Word on a single tap and a firmware Caps Lock flag (`sw_caps_lock_active`) on a double tap, and Esc must end both.
- Never `register_unicode` a symbol that has a physical ABNT2 key: on Linux it goes through IBus Ctrl+Shift+U, so browsers see no keydown and there is no hold-to-repeat. Unicode stays only for º ª § –.
- `OS_LANG` switches the OS layout only; the `LA_*` keys follow `get_keyboard_layout()`, so the OS must have exactly two input sources (US and ABNT2).
- `#if RGB_MATRIX_ENABLE` (as in `luizrocha.c`) is fragile when the macro is undefined; write `#if defined(RGB_MATRIX_ENABLE)` in new code.
