#!/usr/bin/env python3
"""What a session itself spent, read from its transcript.

    spend.py DIR    the tokens the session that owns DIR used in its own answers

A fleet's ledger counts its workers' tokens as they report. What the coordinator spends on
coordinating them is in no ledger: it is in the session's transcript, where Claude Code writes the
usage of every answer. DIR is a directory in a session's scratchpad
(.../<project>/<session>/scratchpad/<name>), which names the transcript:
$CLAUDE_CONFIG_DIR (~/.claude) /projects/<project>/<session>.jsonl.

The figures: `output` the tokens written, `input` the tokens read (fresh, written to the cache,
and read from it), `cached` the part of the input that came from the cache, `answers` how many
answers. Workers' answers are theirs and are left out. A session resumed under a new id writes to
another transcript, which this does not follow.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_held: dict[str, dict] = {}   # transcript path -> what was read of it so far


def forget() -> None:
    _held.clear()


def transcript_of(root) -> Path | None:
    """The transcript of the session whose scratchpad holds DIR, or None when DIR is no such directory."""
    parts = Path(root).resolve().parts
    if len(parts) < 4 or parts[-2] != "scratchpad":
        return None
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    return config / "projects" / parts[-4] / f"{parts[-3]}.jsonl"


def active(root) -> str | None:
    """When the session whose scratchpad holds DIR last wrote its transcript, or None when unknown."""
    path = transcript_of(root)
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).astimezone().isoformat(timespec="seconds") if path else None
    except OSError:
        return None


def _figures(usage: dict) -> tuple[int, int, int, int]:
    number = lambda key: int(usage.get(key) or 0) if isinstance(usage.get(key), (int, float)) else 0  # noqa: E731
    return number("output_tokens"), number("input_tokens"), number("cache_creation_input_tokens"), number("cache_read_input_tokens")


def of(root, wait: float = 5) -> dict | None:
    """What the session that owns DIR spent, or None when it has no transcript. The transcript is
    read from where the last look stopped, and looked at again once `wait` seconds have passed."""
    path = transcript_of(root)
    if path is None:
        return None
    key, now = str(path), time.monotonic()
    held = _held.get(key)
    if held and now - held["looked"] < wait:
        return held["spent"]
    try:
        size = path.stat().st_size
    except OSError:
        _held.pop(key, None)
        return None
    if not held or size < held["offset"] or path.stat().st_ino != held["inode"]:
        held = {"offset": 0, "answers": {}, "inode": path.stat().st_ino}
    if size > held["offset"]:
        with open(path, "rb") as f:
            f.seek(held["offset"])
            chunk = f.read(size - held["offset"])
        whole = chunk[:chunk.rfind(b"\n") + 1]   # a line without its newline is still being written
        held["offset"] += len(whole)
        for line in whole.split(b"\n"):
            if b'"usage"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            message = record.get("message") if isinstance(record, dict) else None
            if record.get("type") != "assistant" or record.get("isSidechain") or not isinstance(message, dict):
                continue
            if isinstance(message.get("usage"), dict) and isinstance(message.get("id"), str):
                held["answers"][message["id"]] = _figures(message["usage"])   # the last line of an answer has its figures
    rows = held["answers"].values()
    cached = sum(r[3] for r in rows)
    held.update(looked=now, spent={"output": sum(r[0] for r in rows), "input": sum(r[1] + r[2] for r in rows) + cached,
                                   "cached": cached, "answers": len(held["answers"])})
    _held[key] = held
    return held["spent"]


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        sys.stderr.write("usage: spend.py DIR\n")
        sys.exit(1)
    spent = of(argv[0], wait=0)
    if spent is None:
        print(f"no transcript for {argv[0]}: it is not a directory in a session's scratchpad, or the session has not answered yet")
        return
    share = round(100 * spent["cached"] / spent["input"]) if spent["input"] else 0
    print(f"{spent['output']:,} tokens written and {spent['input']:,} read ({share}% from the cache) in {spent['answers']:,} answers")


if __name__ == "__main__":
    main(sys.argv[1:])
