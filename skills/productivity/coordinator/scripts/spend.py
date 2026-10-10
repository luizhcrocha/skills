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
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_held: dict[str, dict] = {}   # transcript path -> what was read of it so far


def forget() -> None:
    _held.clear()


ACTIVE_S = 10  # how often the workers' transcripts are looked at again


def transcript_of(root) -> Path | None:
    """The transcript of the session whose scratchpad holds DIR, or None when DIR is no such directory."""
    parts = Path(root).resolve().parts
    if len(parts) < 4 or parts[-2] != "scratchpad":
        return None
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    return config / "projects" / parts[-4] / f"{parts[-3]}.jsonl"


def session_folder(session_id) -> Path | None:
    """The folder beside session SESSION_ID's transcript (`projects/<project>/<session>`), in whichever project
    holds that transcript or folder, or None."""
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        return None
    projects = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    try:
        found = sorted(p / session_id for p in projects.iterdir())
    except OSError:
        return None
    return next((f for f in found if f.is_dir() or f.with_name(f"{session_id}.jsonl").exists()), None)


def serving_transcript(root, session_id=None) -> Path | None:
    """The transcript of the session serving DIR now: session SESSION_ID's, the one its registry entry records
    (a resumed session has a new id while DIR stays in the scratchpad of the session that made it), when
    found, else the scratchpad's."""
    folder = session_folder(session_id)
    own = folder.with_name(f"{folder.name}.jsonl") if folder else None
    return own if own and own.exists() else transcript_of(root)


def active(root, session_id=None) -> str | None:
    """When the session serving DIR (session SESSION_ID, else the scratchpad's) last wrote its transcript,
    or None when unknown."""
    path = serving_transcript(root, session_id)
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).astimezone().isoformat(timespec="seconds") if path else None
    except OSError:
        return None


_WHO = re.compile(r"(?:your id is|You are) ([A-Za-z][A-Za-z0-9_.-]*?)[,.\s\"]")
_named: dict[str, str | None] = {}          # transcript path -> the ledger id its brief names, read once
_active_cache: dict[str, tuple[float, dict]] = {}


def last_activity(root) -> dict[str, float]:
    """When each worker of the session whose scratchpad holds DIR last wrote its transcript, by the id its
    brief gave it ("You are b50", "your id is b50"): a worker's liveness, whether or not its row names its
    task id. Looked up at most every ACTIVE_S seconds."""
    key = str(root)
    hit = _active_cache.get(key)
    if hit and time.monotonic() - hit[0] < ACTIVE_S:
        return hit[1]
    transcript = transcript_of(root)
    folder = transcript.with_suffix("") / "subagents" if transcript else None
    seen: dict[str, float] = {}
    for path in (folder.glob("agent-*.jsonl") if folder and folder.is_dir() else []):
        name = str(path)
        if name not in _named:
            try:
                with open(path, "rb") as fh:
                    found = _WHO.search(fh.readline(20000).decode("utf-8", "replace"))
            except OSError:
                continue
            _named[name] = found.group(1) if found else None
        wid = _named[name]
        if not wid:
            continue
        try:
            at = path.stat().st_mtime
        except OSError:
            continue
        seen[wid] = max(seen.get(wid, 0.0), at)
    _active_cache[key] = (time.monotonic(), seen)
    return seen


def worker(root, task_id: str) -> dict | None:
    """What the worker `task_id` of the session whose scratchpad holds DIR has used, from its own
    transcript: `tokens` its context at its last answer (what a task notification reports as
    subagent_tokens), `duration_ms` from its first line to its last, and `at` the transcript's mtime.
    None when there is no such transcript."""
    transcript = transcript_of(root)
    path = transcript.with_suffix("") / "subagents" / f"agent-{task_id}.jsonl" if transcript else None
    try:
        mtime = path.stat().st_mtime if path else None
        lines = path.read_text(encoding="utf-8").splitlines() if path else []
    except OSError:
        return None
    last, first_at, last_at = None, None, None
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        at = row.get("timestamp") if isinstance(row, dict) else None
        if isinstance(at, str):
            first_at, last_at = first_at or at, at
        message = row.get("message") if isinstance(row, dict) else None
        if isinstance(message, dict) and isinstance(message.get("usage"), dict):
            last = message["usage"]
    if last is None:
        return None
    output, fresh, written, cached = _figures(last)
    span = 0
    try:
        span = int((datetime.fromisoformat(last_at.replace("Z", "+00:00")) - datetime.fromisoformat(first_at.replace("Z", "+00:00"))).total_seconds() * 1000)
    except (AttributeError, ValueError):
        pass
    return {"tokens": output + fresh + written + cached, "duration_ms": span, "at": mtime}


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
