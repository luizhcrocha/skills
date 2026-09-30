#!/usr/bin/env python3
"""This project's Claude Code sessions, for recall's catch-up mode.

    sessions.py list [--days N] [--exclude SESSION_ID] [--cwd DIR]
    sessions.py digest <transcript.jsonl> [--width N]
    sessions.py path <SESSION_ID> [--cwd DIR]

`list` prints one tab-separated row per session of this project changed in the
last N days (default 7), newest first: id, last write, start, kind (`cli` for
an interactive session, `headless` for `claude -p`), user prompts, subagents,
size, title, first prompt, path. `digest` prints a transcript as a timeline a
reader can scan: user prompts, assistant text, one line per tool call, errors,
compaction and away summaries; tool output is left out. `path` prints a
session's own transcript path (reflect and show-me-your-work read the current
one).

The project is every jj workspace of the repo at --cwd (else the git top
level, else the directory itself). Claude Code keeps a session under
<config>/projects/<slug>/<session-id>.jsonl, where <config> is
$CLAUDE_CONFIG_DIR or ~/.claude and <slug> is the launch directory with every
character other than a letter or digit turned into `-`; its subagents under
<slug>/<session-id>/subagents/agent-<id>.jsonl. Only the slugs of this
project's workspace roots are read: a session launched from a subdirectory
has a slug of its own and is not listed.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def slug(path):
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def projects_dir(env=os.environ):
    return Path(env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"


def _run(cmd, cwd):
    try:
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def workspace_roots(cwd):
    out = _run(["jj", "workspace", "list", "-T", 'root ++ "\\n"'], cwd)
    if out and out.strip():
        return [line for line in out.splitlines() if line]
    out = _run(["git", "rev-parse", "--show-toplevel"], cwd)
    if out and out.strip():
        return [out.strip()]
    return [str(Path(cwd).resolve())]


def _text(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if b.get("type") == "text")


def _prompt(record):
    """The user's own words in a user record, or None (meta, tool results, caveats)."""
    if record.get("type") != "user" or record.get("isMeta") or record.get("isCompactSummary"):
        return None
    text = _text(record.get("message", {}).get("content")).strip()
    if not text or text.startswith("<local-command-") or text.startswith("[Request interrupted"):
        return None
    name = re.search(r"<command-name>(.*?)</command-name>", text, re.S)
    if name:
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
        return (name.group(1).strip() + " " + (args.group(1).strip() if args else "")).strip()
    return text


def _one_line(text, width):
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: width - 1] + "…"


def summarize(path):
    row = {"id": path.stem, "path": str(path), "start": "", "kind": "", "prompts": 0,
           "title": "", "first": "", "size": path.stat().st_size, "mtime": path.stat().st_mtime}
    with path.open(errors="replace") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not row["start"] and r.get("timestamp"):
                row["start"] = r["timestamp"][:16].replace("T", " ")
            if not row["kind"] and r.get("entrypoint"):
                row["kind"] = "headless" if r["entrypoint"] == "sdk-cli" else r["entrypoint"]
            if r.get("type") == "ai-title" and r.get("aiTitle"):
                row["title"] = r["aiTitle"]
            p = _prompt(r)
            if p is not None:
                row["prompts"] += 1
                if not row["first"]:
                    row["first"] = p
    sub = path.with_suffix("") / "subagents"
    row["subagents"] = len(list(sub.glob("*.jsonl"))) if sub.is_dir() else 0
    return row


def sessions(roots, days, exclude=(), base=None, now=None):
    base = base or projects_dir()
    cutoff = (now or time.time()) - days * 86400
    found = {}
    for root in roots:
        d = base / slug(root)
        if not d.is_dir():
            continue
        for f in d.glob("*.jsonl"):
            if f.stem in exclude or f.stat().st_mtime < cutoff:
                continue
            found[f.stem] = summarize(f)
    return sorted(found.values(), key=lambda r: r["mtime"], reverse=True)


def cmd_list(args):
    roots = workspace_roots(args.cwd)
    rows = sessions(roots, args.days, set(args.exclude))
    print(f"# project roots: {', '.join(roots)}; last {args.days} days; {len(rows)} sessions")
    print("id\tlast\tstart\tkind\tprompts\tsubagents\tsize\ttitle\tfirst prompt\tpath")
    for r in rows:
        last = datetime.fromtimestamp(r["mtime"], timezone.utc).strftime("%Y-%m-%d %H:%M")
        print("\t".join([r["id"], last, r["start"], r["kind"] or "?", str(r["prompts"]),
                         str(r["subagents"]), f"{r['size'] // 1024}K", _one_line(r["title"], 60),
                         _one_line(r["first"], 160), r["path"]]))
    return 0


def _tool_line(block):
    inp = block.get("input") or {}
    detail = (inp.get("description") or inp.get("command") or inp.get("file_path")
              or inp.get("pattern") or inp.get("prompt") or inp.get("skill") or "")
    return f"{block.get('name')}: {detail}"


def digest(path, width=400):
    with Path(path).open(errors="replace") as fh:
        yield from _digest(fh, width)


def _digest(fh, width):
    for line in fh:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        ts = (r.get("timestamp") or "")[:16].replace("T", " ")
        kind = r.get("type")
        if kind == "user":
            if r.get("isCompactSummary"):
                yield f"{ts} COMPACTED: {_one_line(_text(r['message'].get('content')), width)}"
                continue
            p = _prompt(r)
            if p is not None and p.startswith("<task-notification>"):
                done = re.search(r"<summary>(.*?)</summary>", p, re.S)
                yield f"{ts}   AGENT DONE: {_one_line(done.group(1) if done else p, width)}"
            elif p is not None:
                yield f"{ts} USER: {_one_line(p, width * 2)}"
            content = r.get("message", {}).get("content")
            for b in content if isinstance(content, list) else []:
                if b.get("type") == "tool_result" and b.get("is_error"):
                    yield f"{ts}   ERROR: {_one_line(_text(b.get('content')), width)}"
        elif kind == "assistant":
            for b in r.get("message", {}).get("content") or []:
                if b.get("type") == "text" and b.get("text", "").strip():
                    yield f"{ts} ASSISTANT: {_one_line(b['text'], width)}"
                elif b.get("type") == "tool_use":
                    yield f"{ts}   TOOL {_one_line(_tool_line(b), 200)}"
        elif kind == "system" and r.get("subtype") == "away_summary":
            yield f"{ts} AWAY SUMMARY: {_one_line(r.get('content', ''), width)}"


def transcript_path(session_id, roots, base=None):
    """This session's own transcript: this project's slugs first, then the one
    file named after the id wherever it was launched (ids are unique, so no
    other session's transcript is opened)."""
    base = base or projects_dir()
    for root in roots:
        f = base / slug(root) / f"{session_id}.jsonl"
        if f.is_file():
            return f
    return next(iter(sorted(base.glob(f"*/{session_id}.jsonl"))), None)


def cmd_path(args):
    f = transcript_path(args.session_id, workspace_roots(args.cwd))
    if f is None:
        print(f"no transcript for session {args.session_id}", file=sys.stderr)
        return 1
    print(f)
    return 0


def cmd_digest(args):
    for line in digest(args.transcript, args.width):
        print(line)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list")
    ls.add_argument("--days", type=float, default=7)
    ls.add_argument("--exclude", action="append", default=[], metavar="SESSION_ID")
    ls.add_argument("--cwd", default=os.getcwd())
    ls.set_defaults(func=cmd_list)
    dg = sub.add_parser("digest")
    dg.add_argument("transcript")
    dg.add_argument("--width", type=int, default=400)
    dg.set_defaults(func=cmd_digest)
    pa = sub.add_parser("path")
    pa.add_argument("session_id")
    pa.add_argument("--cwd", default=os.getcwd())
    pa.set_defaults(func=cmd_path)
    args = p.parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
