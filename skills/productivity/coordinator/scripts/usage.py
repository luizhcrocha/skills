#!/usr/bin/env python3
"""The plan's usage, captured from what Claude Code hands a status line.

    usage.py capture [-- COMMAND...]  read the status line's input on stdin, keep its rate limits,
                                      then run COMMAND on the same input: the status line as it was
    usage.py show                     what is held: each window's percent used and when it resets

Claude Code gives a status line `rate_limits` (the 5-hour and the 7-day window, each with
`used_percentage` and `resets_at`) for a subscription, after a session's first response. Every
session on the machine runs the status line, so with `capture` as its command the reading follows
whichever session worked last. It is kept in usage/reading.json under the registry of fleets
(the registry's own directory holds fleets only), and the manager's page is sent it.

As the status line's command in settings.json:

    "statusLine": {"type": "command", "command": "python3 <skill-dir>/scripts/usage.py capture -- <the command it had>"}

Capturing never costs the status line: whatever goes wrong here, COMMAND runs on the input it was given.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clock  # noqa: E402
import fleets  # noqa: E402

WINDOWS = {"five_hour": "5-hour window", "seven_day": "7-day window"}


def _path() -> Path:
    return fleets.home() / "usage" / "reading.json"


def read() -> dict | None:
    """What is held, `{window: {"used_percentage", "resets_at", "at"}}`, or None when nothing was captured."""
    try:
        held = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    windows = {k: v for k, v in held.items() if k in WINDOWS and _reading(v)} if isinstance(held, dict) else {}
    return windows or None


def _reading(value) -> bool:
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)  # noqa: E731
    return isinstance(value, dict) and number(value.get("used_percentage")) and number(value.get("resets_at"))


def keep(limits) -> None:
    """Fold a status line's `rate_limits` into what is held. A window the input leaves out is kept.
    Within a window usage only grows, so an idle session's older figure does not replace a newer
    one; a window that resets later is a new window and replaces the one before it."""
    if not isinstance(limits, dict):
        return
    held, changed = read() or {}, False
    for window in WINDOWS:
        new, old = limits.get(window), held.get(window)
        if not _reading(new):
            continue
        newer = not old or new["resets_at"] > old["resets_at"] or (
            new["resets_at"] == old["resets_at"] and new["used_percentage"] >= old["used_percentage"])
        if newer:
            held[window] = {"used_percentage": new["used_percentage"], "resets_at": new["resets_at"], "at": int(clock.time())}
            changed = True
    if changed:
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        scratch = path.with_name(f"reading.{os.getpid()}.tmp")
        scratch.write_text(json.dumps(held) + "\n", encoding="utf-8")
        scratch.replace(path)


def capture(command: list[str]) -> int:
    given = sys.stdin.buffer.read()
    try:
        status = json.loads(given)
        keep(status.get("rate_limits") if isinstance(status, dict) else None)
    except Exception:  # noqa: BLE001  the status line comes first: nothing here may stop it
        pass
    if not command:
        return 0
    try:
        return subprocess.run(command, input=given).returncode
    except OSError as exc:
        sys.stderr.write(f"usage: cannot run {command[0]}: {exc.strerror or exc}\n")
        return 127


def show() -> None:
    held = read()
    if not held:
        print("no usage captured yet: the status line has not run through `fleet usage capture`")
        return
    now = clock.time()
    for window, label in WINDOWS.items():
        r = held.get(window)
        if r:
            resets = "has reset since" if r["resets_at"] <= now else f"resets {time.strftime('%a %H:%M', time.localtime(r['resets_at']))}"
            print(f"{label}: {r['used_percentage']:g}% used, {resets}, read {int(now - r['at'])} s ago")


def main(argv: list[str]) -> None:
    if argv[:1] == ["capture"]:
        rest = argv[1:]
        sys.exit(capture(rest[1:] if rest[:1] == ["--"] else rest))
    if argv == ["show"]:
        show()
        return
    sys.stderr.write("usage: usage.py capture [-- COMMAND...] | show\n")
    sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
