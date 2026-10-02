#!/usr/bin/env python3
"""The plan's usage, captured from what Claude Code hands a status line.

    usage.py capture [-- COMMAND...]  read the status line's input on stdin, keep its rate limits,
                                      then run COMMAND on the same input: the status line as it was
    usage.py show                     what is held: per account, each window's percent used and when it resets

Claude Code gives a status line `rate_limits` (the 5-hour and the 7-day window, each with
`used_percentage` and `resets_at`) for a subscription, after a session's first response. Every
session on the machine runs the status line, and sessions may run under different logins, so a
reading is kept per account: the one logged in to the session's config directory
(`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`, its `oauthAccount`), which the status
line's input does not name. The readings are kept in usage/reading.json under the registry of fleets
(the registry's own directory holds fleets only), and the manager's page is sent them: first the
account whose session captured last, then the others.

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
UNKNOWN = {"key": "unknown", "email": None}


def _path() -> Path:
    return fleets.home() / "usage" / "reading.json"


def account() -> dict | None:
    """Who the session is logged in as, `{"key", "email"}`, from its config's `.claude.json` (where Claude
    Code keeps it: `$CLAUDE_CONFIG_DIR`, else the home directory); only `oauthAccount`'s ids and email
    are read. The key is the account and its organization, whose plan the limits are. A config with no
    login is UNKNOWN; None when the file is there but can't be read, so nothing is kept under a wrong name."""
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    path = Path(config) / ".claude.json" if config else Path.home() / ".claude.json"
    try:
        held = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return UNKNOWN
    except (OSError, ValueError):
        return None
    oauth = held.get("oauthAccount") if isinstance(held, dict) else None
    uuid = oauth.get("accountUuid") if isinstance(oauth, dict) else None
    if not isinstance(uuid, str) or not uuid:
        return UNKNOWN
    org, email = oauth.get("organizationUuid"), oauth.get("emailAddress")
    return {"key": f"{uuid}:{org}" if isinstance(org, str) and org else uuid, "email": email if isinstance(email, str) and email else None}


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _reading(value) -> bool:
    return isinstance(value, dict) and _number(value.get("used_percentage")) and _number(value.get("resets_at"))


def accounts() -> dict:
    """What is held, `{key: {"email", "seen", window: {"used_percentage", "resets_at", "at"}}}`, the account
    that captured last first. `seen` is when it last did. The file before accounts (its windows at the top)
    reads as UNKNOWN, seen when its newest window was."""
    try:
        held = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(held, dict):
        return {}
    given = held.get("accounts") if "accounts" in held else {UNKNOWN["key"]: held}
    out = {}
    for key, entry in (given.items() if isinstance(given, dict) else ()):
        windows = {w: entry[w] for w in WINDOWS if _reading(entry.get(w))} if isinstance(entry, dict) else {}
        if not windows:
            continue
        email = entry.get("email")
        seen = entry.get("seen") if _number(entry.get("seen")) else max((r["at"] for r in windows.values() if _number(r.get("at"))), default=0)
        out[key] = {"email": email if isinstance(email, str) else None, "seen": seen, **windows}
    return out


def read() -> dict | None:
    """What the page is sent: the account whose session captured last, `{"account" (its email, None when
    not recorded), "seen", window..., "others": [the same for every other account, latest first]}`, or
    None when nothing was captured."""
    held = sorted(accounts().values(), key=lambda e: -e["seen"])
    if not held:
        return None
    shown = lambda e: {"account": e["email"], "seen": e["seen"], **{w: e[w] for w in WINDOWS if w in e}}  # noqa: E731
    return {**shown(held[0]), "others": [shown(e) for e in held[1:]]}


def keep(limits, who: dict | None = None) -> None:
    """Fold a status line's `rate_limits` into the account's reading, `who` (account() when not given).
    A window the input leaves out is kept. Within a window usage only grows, so an idle session's
    older figure does not replace a newer one; a window that resets later is a new window and replaces
    the one before it. Another account's reading whose windows have all reset is dropped."""
    who = account() if who is None else who
    if not isinstance(limits, dict) or who is None:
        return
    now = clock.time()
    held = accounts()
    mine, given = dict(held.get(who["key"], {})), False
    for window in WINDOWS:
        new, old = limits.get(window), mine.get(window)
        if not _reading(new):
            continue
        given = True
        newer = not old or new["resets_at"] > old["resets_at"] or (
            new["resets_at"] == old["resets_at"] and new["used_percentage"] >= old["used_percentage"])
        if newer:
            mine[window] = {"used_percentage": new["used_percentage"], "resets_at": new["resets_at"], "at": int(now)}
    if not given:
        return
    held = {who["key"]: {"email": who["email"], "seen": int(now), **{w: mine[w] for w in WINDOWS if w in mine}},
            **{k: e for k, e in held.items() if k != who["key"] and any(e[w]["resets_at"] > now for w in WINDOWS if w in e)}}
    text = json.dumps({"accounts": held}) + "\n"
    path = _path()
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    scratch = path.with_name(f"reading.{os.getpid()}.tmp")
    scratch.write_text(text, encoding="utf-8")
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
    for i, r in enumerate([held, *held["others"]]):
        name = r["account"] or "an account not recorded"
        print(f"{name}, the session that worked last:" if i == 0 else f"{name}:")
        for window, label in WINDOWS.items():
            w = r.get(window)
            if w:
                resets = "has reset since" if w["resets_at"] <= now else f"resets {time.strftime('%a %H:%M', time.localtime(w['resets_at']))}"
                print(f"  {label}: {w['used_percentage']:g}% used, {resets}, read {int(now - w['at'])} s ago")


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
